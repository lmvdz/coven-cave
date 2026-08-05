import { NextResponse } from "next/server";
import { rejectNonLocalRequest } from "@/lib/server/api-security";
import {
  configureRole,
  configureSharing,
  createEnrollment,
  decidePairing,
  enrollWithCredential,
  fleetSnapshot,
  pollPairing,
  requestPairing,
  revokeNode,
  runLifecycle,
  type FleetRole,
} from "@/lib/server/fleet-control";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type FleetAction =
  | { action: "role"; role: FleetRole }
  | { action: "sharing"; enabled: boolean }
  | { action: "lifecycle"; lifecycle: "start" | "stop" | "restart" | "drain" | "resume" }
  | { action: "create-enrollment" }
  | { action: "enroll"; candidateId: string; credential: string }
  | { action: "request-pairing"; candidateId: string }
  | { action: "poll-pairing"; operationId: string }
  | { action: "decide-pairing"; requestId: string; decision: "approve" | "deny" }
  | { action: "revoke"; nodeId: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The fleet operation failed. Retry.";
}

export async function GET(req: Request) {
  const forbidden = rejectNonLocalRequest(req);
  if (forbidden) return forbidden;
  try {
    return NextResponse.json({ ok: true, ...(await fleetSnapshot()) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: message(error) }, { status: 503 });
  }
}

export async function POST(req: Request) {
  const forbidden = rejectNonLocalRequest(req);
  if (forbidden) return forbidden;
  let body: FleetAction;
  try {
    body = await req.json() as FleetAction;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  try {
    let result: unknown;
    switch (body.action) {
      case "role":
        if (!["hub", "executor", "both"].includes(body.role)) throw new Error("Choose hub, executor, or both.");
        result = await configureRole(body.role);
        break;
      case "sharing":
        result = await configureSharing(body.enabled);
        break;
      case "lifecycle":
        if (!["start", "stop", "restart", "drain", "resume"].includes(body.lifecycle)) {
          throw new Error("Choose a supported lifecycle action.");
        }
        result = await runLifecycle(body.lifecycle);
        break;
      case "create-enrollment":
        result = await createEnrollment();
        break;
      case "enroll":
        result = await enrollWithCredential(body.candidateId, body.credential);
        break;
      case "request-pairing":
        result = await requestPairing(body.candidateId);
        break;
      case "poll-pairing":
        result = await pollPairing(body.operationId);
        break;
      case "decide-pairing":
        result = await decidePairing(body.requestId, body.decision);
        break;
      case "revoke":
        result = await revokeNode(body.nodeId);
        break;
      default:
        return NextResponse.json({ ok: false, error: "Unsupported fleet action." }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: message(error) }, { status: 502 });
  }
}
