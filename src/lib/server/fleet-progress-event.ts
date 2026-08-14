import type { StreamEvent } from "@/lib/stream-events";

const MAX_PROGRESS_ID = 64;
const MAX_PROGRESS_LABEL = 160;
const SAFE_PROGRESS_ID = /^[A-Za-z0-9._-]+$/;
const PROGRESS_STATUSES = new Set(["running", "done", "notice", "error"]);

export function parseFleetProgressLine(line: string): Extract<StreamEvent, { kind: "progress" }> | null {
  if (!line.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.type !== "fleet_progress" || event.schemaVersion !== "coven.fleet.progress.v1") return null;
  if (typeof event.id !== "string" || event.id.length === 0 || event.id.length > MAX_PROGRESS_ID || !SAFE_PROGRESS_ID.test(event.id)) return null;
  if (typeof event.label !== "string" || event.label.length === 0 || event.label.length > MAX_PROGRESS_LABEL) return null;
  if (typeof event.status !== "string" || !PROGRESS_STATUSES.has(event.status)) return null;
  return {
    kind: "progress",
    id: `fleet-executor-${event.id}`,
    label: event.label,
    status: event.status as "running" | "done" | "notice" | "error",
  };
}
