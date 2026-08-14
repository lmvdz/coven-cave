import assert from "node:assert/strict";
import { parseFleetProgressLine } from "./fleet-progress-event.ts";

assert.deepEqual(
  parseFleetProgressLine('{"type":"fleet_progress","schemaVersion":"coven.fleet.progress.v1","id":"workspace","label":"Workspace ready","status":"done"}'),
  { kind: "progress", id: "fleet-executor-workspace", label: "Workspace ready", status: "done" },
);
assert.equal(parseFleetProgressLine('{"type":"fleet_progress","id":"workspace","label":"Missing schema","status":"done"}'), null);
assert.equal(parseFleetProgressLine('{"type":"fleet_progress","schemaVersion":"coven.fleet.progress.v1","id":"../secret","label":"Unsafe id","status":"running"}'), null);
assert.equal(parseFleetProgressLine("ordinary runtime output"), null);

console.log("Fleet progress event parsing: ok");
