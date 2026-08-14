import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const route = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");
const localSend = readFileSync(fileURLToPath(new URL("../route.ts", import.meta.url)), "utf8");
const chat = readFileSync(fileURLToPath(new URL("../../../../../components/chat-view.tsx", import.meta.url)), "utf8");
const control = readFileSync(fileURLToPath(new URL("../../../../../lib/server/fleet-control.ts", import.meta.url)), "utf8");

assert.match(route, /rejectNonLocalRequest/, "the browser-facing route remains loopback-only");
assert.match(route, /queueRemoteFleetTurn\(\{[\s\S]*?turnId,[\s\S]*?targetNodeId,[\s\S]*?contextMessages,[\s\S]*?permissionMode/);
assert.match(route, /resolveActivePath\(conversation\.turns, conversation\.activeLeafId\)/, "only canonical active-branch context is replayed");
assert.match(route, /withConversationLock\(sessionId,[\s\S]*?current\.turns\.some\(\(turn\) => turn\.id === turnId\)/, "a retry cannot persist the turn twice");
assert.match(route, /delete current\.harnessSessionId/, "a machine-local resume id cannot outrank the canonical remote turn");
assert.match(route, /runtime = `fleet:\$\{targetNodeId\}:\$\{projectRoot\}`/);
assert.match(route, /executorNodeId: targetNodeId/, "persisted response metadata carries executor provenance");
assert.match(route, /fleetJobEvents[\s\S]*?assistant_chunk/, "executor JSONL events are projected into the existing chat stream");
assert.match(route, /projectName:[\s\S]*?repositoryUrl:[\s\S]*?checkpoint/, "workspace identity and revision ride with the turn");
assert.doesNotMatch(route, /nodeCredential|requestSecret|proof:/, "Fleet credentials never enter the browser route payload");
assert.match(control, /authenticatedRemotePayload[\s\S]*?capabilities:[\s\S]*?fleet-chat-turn-v1/, "executor heartbeats advertise remote-turn compatibility");
assert.match(control, /activeExecutorWork[\s\S]*?forwardExecutorEvents[\s\S]*?\/fleet\/jobs\/status/, "background execution keeps streaming and cancellation polls alive beyond the native worker timeout");
assert.match(chat, /fleetNodeIdFromHostOption\(fleetHost \?\? ""\)/);
assert.match(chat, /fleetNodeId \? "\/api\/chat\/send\/fleet" : "\/api\/chat\/send"/, "placement changes only the selected turn's transport");
assert.match(chat, /remoteFleetTurnRef[\s\S]*?method: "DELETE"/, "Stop targets the selected remote turn");
assert.match(localSend, /previousTurnRanOnFleet[\s\S]*?canonical continuation context[\s\S]*?executionPromptText/, "the following local turn replays hub-canonical context instead of resuming stale machine-local state");

console.log("Fleet remote chat route contract: ok");
