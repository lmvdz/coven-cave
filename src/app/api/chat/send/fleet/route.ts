import { NextResponse } from "next/server";
import { loadConversation, saveConversation, withConversationLock, type ChatTurn } from "@/lib/cave-conversations";
import { extractRewrite } from "@/lib/reader-rewrite";
import { rejectNonLocalRequest } from "@/lib/server/api-security";
import { cancelFleetJob, fleetJob, fleetJobEvents, queueRemoteFleetTurn, type FleetJobEvent } from "@/lib/server/fleet-control";
import { normalizeChatAttachments, stripPreviewOnlyAttachmentFields, type ChatAttachment } from "@/lib/chat-attachments";
import { persistImageAttachments } from "@/app/api/chat/send/chat-send-attachments";
import type { StreamEvent } from "@/lib/stream-events";
import { resolveActivePath } from "@/lib/conversation-tree";
import { loadProjects } from "@/lib/cave-projects";
import { assertProjectAccess, ProjectAccessDeniedError } from "@/lib/project-permissions";
import { capturePortableFleetWorkspace } from "@/lib/server/fleet-workspace";
import { buildFamiliarContractBlock } from "@/lib/server/familiar-contract-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POLL_MS = 500;
const MAX_CONTEXT_MESSAGES = 256;
const MAX_CONTEXT_BYTES = 768 * 1024;
const MAX_ATTACHMENT_BYTES = 768 * 1024;
const SAFE_ID = /^[A-Za-z0-9._:/-]{1,4096}$/;
type RemoteSendBody = {
  familiarId?: unknown;
  prompt?: unknown;
  runId?: unknown;
  turnId?: unknown;
  sessionId?: unknown;
  projectRoot?: unknown;
  targetNodeId?: unknown;
  permissionMode?: unknown;
  modelOverride?: unknown;
  parentTurnId?: unknown;
  attachments?: unknown;
};

function stringField(value: unknown): string | null {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

function remoteAttachments(value: unknown): Array<{ name: string; mimeType: string; dataBase64: string }> {
  if (!Array.isArray(value)) return [];
  let total = 0;
  const result: Array<{ name: string; mimeType: string; dataBase64: string }> = [];
  for (const raw of value.slice(0, 8)) {
    const attachment = raw as ChatAttachment;
    const name = typeof attachment?.name === "string" ? attachment.name.slice(0, 180) : "attachment";
    const mimeType = (attachment?.mimeType ?? attachment?.type ?? "application/octet-stream").slice(0, 120);
    let dataBase64 = "";
    if (typeof attachment?.dataUrl === "string") {
      const comma = attachment.dataUrl.indexOf(",");
      if (comma >= 0 && /;base64$/i.test(attachment.dataUrl.slice(0, comma))) {
        dataBase64 = attachment.dataUrl.slice(comma + 1);
      }
    } else if (typeof attachment?.text === "string") {
      dataBase64 = Buffer.from(attachment.text, "utf8").toString("base64");
    }
    if (!dataBase64) continue;
    total += Buffer.byteLength(dataBase64, "base64");
    if (total > MAX_ATTACHMENT_BYTES) throw new Error("Remote turn attachments exceed 768 KB.");
    result.push({ name, mimeType, dataBase64 });
  }
  return result;
}

function sse(event: StreamEvent, cursor: number): Uint8Array {
  return new TextEncoder().encode(`id: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function DELETE(req: Request) {
  const forbidden = rejectNonLocalRequest(req);
  if (forbidden) return forbidden;
  const turnId = stringField(new URL(req.url).searchParams.get("turnId"));
  if (!turnId) return NextResponse.json({ ok: false, error: "A valid turn id is required." }, { status: 400 });
  try {
    const result = await cancelFleetJob(`fleetturn_${turnId}`);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "The remote turn could not be cancelled." },
      { status: 502 },
    );
  }
}

export async function GET(req: Request) {
  const forbidden = rejectNonLocalRequest(req);
  if (forbidden) return forbidden;
  const url = new URL(req.url);
  const turnId = stringField(url.searchParams.get("turnId"));
  const sessionId = stringField(url.searchParams.get("sessionId"));
  let cursor = Math.max(0, Number.parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0);
  if (!turnId || !sessionId) {
    return NextResponse.json({ ok: false, error: "A valid turn and conversation are required." }, { status: 400 });
  }
  const initial = await loadConversation(sessionId);
  if (!initial) return NextResponse.json({ ok: false, error: "Conversation not found." }, { status: 404 });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (event: StreamEvent) => controller.enqueue(sse(event, ++cursor));
      try {
        let job = await fleetJob(`fleetturn_${turnId}`);
        while (job && (job.state === "queued" || job.state === "leased")) {
          await delay(POLL_MS);
          job = await fleetJob(`fleetturn_${turnId}`);
        }
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const conversation = await loadConversation(sessionId);
          const assistant = conversation?.turns.find((turn) => turn.parentId === turnId && turn.role === "assistant");
          if (assistant) {
            push({ kind: "assistant_replace", text: assistant.text });
            push({
              kind: "done",
              durationMs: assistant.durationMs,
              isError: assistant.isError,
              sessionId,
              responseMetadata: assistant.responseMetadata,
            });
            controller.close();
            return;
          }
          await delay(100);
        }
        push({ kind: "error", code: "fleet_transcript_pending", message: "The remote result is still being saved. Reload this conversation to continue." });
        controller.close();
      } catch (error) {
        push({ kind: "error", code: "fleet_reconnect_failed", message: error instanceof Error ? error.message : "Could not reconnect to the remote turn." });
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}

export async function POST(req: Request) {
  const forbidden = rejectNonLocalRequest(req);
  if (forbidden) return forbidden;
  let body: RemoteSendBody;
  try {
    body = await req.json() as RemoteSendBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const familiarId = stringField(body.familiarId);
  const turnId = stringField(body.turnId);
  const sessionId = stringField(body.sessionId);
  const targetNodeId = stringField(body.targetNodeId);
  const parentTurnId = stringField(body.parentTurnId);
  const projectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!familiarId || !turnId || !sessionId || !targetNodeId || !projectRoot || !prompt) {
    return NextResponse.json(
      { ok: false, error: "An existing conversation, executor, workspace, and prompt are required." },
      { status: 400 },
    );
  }
  if (body.permissionMode !== "read" && body.permissionMode !== "full") {
    return NextResponse.json(
      { ok: false, error: "Remote turns require Read-only or Full access. Unattended access stays on this device." },
      { status: 400 },
    );
  }
  const conversation = await loadConversation(sessionId);
  if (!conversation || conversation.familiarId !== familiarId) {
    return NextResponse.json({ ok: false, error: "Conversation not found." }, { status: 404 });
  }
  if (conversation.turns.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Run the first turn on this device before choosing a Fleet executor." },
      { status: 409 },
    );
  }
  if (body.parentTurnId != null && !parentTurnId) {
    return NextResponse.json({ ok: false, error: "The parent turn id is invalid." }, { status: 400 });
  }
  if (parentTurnId && !conversation.turns.some((turn) => turn.id === parentTurnId)) {
    return NextResponse.json({ ok: false, error: "The parent turn was not found in this conversation." }, { status: 409 });
  }
  let attachments: ReturnType<typeof remoteAttachments>;
  try {
    attachments = remoteAttachments(normalizeChatAttachments(body.attachments));
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 413 });
  }
  const model = typeof body.modelOverride === "string" && body.modelOverride.trim()
    ? body.modelOverride.trim()
    : conversation.model;
  const project = (await loadProjects()).find((candidate) => candidate.root === projectRoot);
  if (!project) {
    return NextResponse.json(
      { ok: false, error: "The selected workspace is not a registered Cave project." },
      { status: 403 },
    );
  }
  try {
    await assertProjectAccess(
      { familiarId },
      project.id,
      body.permissionMode === "full" ? "shell" : "chat",
    );
  } catch (error) {
    if (!(error instanceof ProjectAccessDeniedError)) throw error;
    return NextResponse.json(
      { ok: false, error: "This familiar does not have the requested access to that project." },
      { status: 403 },
    );
  }
  let workspace: Awaited<ReturnType<typeof capturePortableFleetWorkspace>>;
  try {
    workspace = await capturePortableFleetWorkspace(projectRoot, project.repoUrl);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "This workspace cannot be prepared for Fleet." },
      { status: 409 },
    );
  }
  const familiarIntent = await buildFamiliarContractBlock(familiarId, { portable: true });
  const contextMessages: Array<{ role: "user" | "assistant" | "system"; text: string }> = [];
  let contextBytes = 0;
  if (familiarIntent) {
    contextMessages.push({ role: "system", text: familiarIntent });
    contextBytes = Buffer.byteLength(familiarIntent, "utf8");
  }
  const activeTurns = (conversation.activeLeafId
    ? resolveActivePath(conversation.turns, conversation.activeLeafId)
    : conversation.turns)
    .filter((turn) => turn.role === "user" || turn.role === "assistant" || turn.role === "system")
    .slice(-(MAX_CONTEXT_MESSAGES - contextMessages.length));
  for (const turn of [...activeTurns].reverse()) {
    const text = turn.text.slice(0, 256 * 1024);
    const bytes = Buffer.byteLength(text, "utf8");
    if (contextBytes + bytes > MAX_CONTEXT_BYTES) break;
    contextMessages.unshift({ role: turn.role, text });
    contextBytes += bytes;
  }
  const permissionMode = body.permissionMode;
  let queued: Awaited<ReturnType<typeof queueRemoteFleetTurn>>;
  try {
    queued = await queueRemoteFleetTurn({
      turnId,
      targetNodeId,
      familiarId,
      harness: conversation.harness,
      ...(model ? { model } : {}),
      workspace: { ...workspace, ...(project?.name ? { projectName: project.name } : {}) },
      prompt,
      contextMessages,
      ...(attachments.length ? { attachments } : {}),
      permissionMode,
      timeoutSeconds: 900,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "The remote turn could not be dispatched." },
      { status: 502 },
    );
  }

  let cursor = 0;
  let streamAttached = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (event: StreamEvent) => {
        if (!streamAttached) return;
        try {
          controller.enqueue(sse(event, ++cursor));
        } catch {
          streamAttached = false;
        }
      };
      const startedAt = Date.now();
      let remoteEventCursor = 0;
      let lineBuffer = "";
      let streamedText = "";
      const utf8 = new TextDecoder();
      const projectEvents = (events: FleetJobEvent[], terminal = false) => {
        for (const event of events) {
          if (event.sequence <= remoteEventCursor) continue;
          remoteEventCursor = event.sequence;
          lineBuffer += utf8.decode(Buffer.from(event.chunkBase64, "base64"), { stream: true });
          let newline = lineBuffer.indexOf("\n");
          while (newline >= 0) {
            const line = lineBuffer.slice(0, newline);
            lineBuffer = lineBuffer.slice(newline + 1);
            const text = extractRewrite(`${line}\n`);
            if (text) {
              streamedText += text;
              push({ kind: "assistant_chunk", text });
            }
            newline = lineBuffer.indexOf("\n");
          }
        }
        if (terminal) {
          lineBuffer += utf8.decode();
          const text = extractRewrite(lineBuffer);
          if (text) {
            streamedText += text;
            push({ kind: "assistant_chunk", text });
          }
          lineBuffer = "";
        }
      };
      try {
        push({ kind: "session", sessionId });
        push({
          kind: "progress",
          id: "fleet-dispatch",
          label: `Queued on ${targetNodeId}`,
          status: "running",
        });
        let job = await fleetJob(queued.jobId);
        while (job && (job.state === "queued" || job.state === "leased")) {
          projectEvents(await fleetJobEvents(queued.jobId));
          await delay(POLL_MS);
          job = await fleetJob(queued.jobId);
        }
        if (!job) throw new Error("The remote turn disappeared from the hub queue.");
        projectEvents(await fleetJobEvents(queued.jobId), true);
        if (job.state === "cancelled") {
          push({ kind: "progress", id: "fleet-dispatch", label: "Remote turn cancelled", status: "error" });
          const cancelledAt = new Date().toISOString();
          await withConversationLock(sessionId, async () => {
            const current = await loadConversation(sessionId);
            if (!current || current.turns.some((turn) => turn.id === turnId)) return;
            const parentId = parentTurnId ?? current.activeLeafId ?? null;
            const userTurn: ChatTurn = {
              id: turnId,
              role: "user",
              text: prompt,
              createdAt: cancelledAt,
              ...(parentId ? { parentId } : {}),
            };
            const assistantTurn: ChatTurn = {
              id: `${turnId}_assistant`,
              parentId: turnId,
              role: "assistant",
              text: "(cancelled)",
              createdAt: cancelledAt,
              durationMs: Date.now() - startedAt,
              isError: true,
              cancelled: true,
              responseMetadata: {
                familiarId,
                harness: conversation.harness,
                model: model || "unknown",
                runtime: `fleet:${targetNodeId}:${projectRoot}`,
                executorNodeId: targetNodeId,
              },
            };
            current.turns.push(userTurn, assistantTurn);
            current.activeLeafId = assistantTurn.id;
            delete current.harnessSessionId;
            await saveConversation(current);
          });
          push({ kind: "done", durationMs: Date.now() - startedAt, isError: true, sessionId });
          return;
        }
        const output = job.result?.stdout ?? "";
        const assistantText = extractRewrite(output);
        const isError = job.state !== "completed" || job.result?.status !== "completed" || !assistantText;
        const visibleText = assistantText || job.result?.error || "The executor finished without returning an assistant response.";
        push({ kind: "progress", id: "fleet-dispatch", label: `Completed on ${targetNodeId}`, status: isError ? "error" : "done" });
        if (visibleText.startsWith(streamedText)) {
          const tail = visibleText.slice(streamedText.length);
          if (tail) push({ kind: "assistant_chunk", text: tail });
        } else if (visibleText !== streamedText) {
          push({ kind: "assistant_replace", text: visibleText });
        }
        const now = new Date().toISOString();
        const runtime = `fleet:${targetNodeId}:${projectRoot}`;
        const responseMetadata = {
          familiarId,
          harness: conversation.harness,
          model: model || "unknown",
          runtime,
          executorNodeId: targetNodeId,
        };
        const sourceAttachments = normalizeChatAttachments(body.attachments);
        const persistedAttachments = await persistImageAttachments(
          stripPreviewOnlyAttachmentFields(sourceAttachments),
          sourceAttachments,
        );
        await withConversationLock(sessionId, async () => {
          const current = await loadConversation(sessionId);
          if (!current || current.turns.some((turn) => turn.id === turnId)) return;
          const parentId = parentTurnId ?? current.activeLeafId ?? null;
          const userTurn: ChatTurn = {
            id: turnId,
            role: "user",
            text: prompt,
            createdAt: now,
            ...(persistedAttachments.length ? { attachments: persistedAttachments } : {}),
            ...(parentId ? { parentId } : {}),
          };
          const assistantTurn: ChatTurn = {
            id: `${turnId}_assistant`,
            parentId: turnId,
            role: "assistant",
            text: visibleText,
            createdAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            isError,
            responseMetadata,
          };
          current.turns.push(userTurn, assistantTurn);
          current.activeLeafId = assistantTurn.id;
          delete current.harnessSessionId;
          await saveConversation(current);
        });
        push({
          kind: "done",
          durationMs: Date.now() - startedAt,
          isError,
          sessionId,
          responseMetadata,
        });
      } catch (error) {
        push({
          kind: "error",
          code: "fleet_remote_turn_failed",
          message: error instanceof Error ? error.message : "The remote turn failed.",
        });
        push({ kind: "done", durationMs: Date.now() - startedAt, isError: true, sessionId });
      } finally {
        if (streamAttached) controller.close();
      }
    },
    cancel() {
      // A webview/network disconnect detaches presentation only. The hub keeps
      // polling and persists the durable terminal result; explicit Stop uses
      // DELETE above and is the only cancellation authority.
      streamAttached = false;
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
