// @ts-nocheck
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fleetPortState } from "./fleet-control.ts";

const control = readFileSync(new URL("./fleet-control.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../../app/api/fleet/route.ts", import.meta.url), "utf8");

assert.match(route, /rejectNonLocalRequest\(req\)/g, "both fleet handlers should reject non-local callers");
assert.equal((route.match(/rejectNonLocalRequest\(req\)/g) || []).length, 2, "GET and POST should each enforce local origin");
assert.match(control, /loadTailscaleDevices\(\)/, "candidate resolution should come from live Tailscale inventory");
assert.match(control, /inventory\.devices\.find\(\(device\) => candidateId\(device\) === id\)/, "mutations should re-resolve candidate ids from inventory");
assert.match(control, /const FLEET_PORT = 8787/, "candidate ports should not be supplied by the browser");
assert.match(control, /const DISCOVERY_TIMEOUT_MS = 1_200/, "candidate probes should have a strict timeout");
assert.match(control, /slice\(0, MAX_DISCOVERY_CANDIDATES\)/, "discovery should bound the number of tailnet peers probed at once");
assert.match(control, /AbortController/, "remote discovery and pairing should be abortable");
assert.doesNotMatch(route, /nodeCredential|requestSecret/, "durable credentials and approval secrets should never cross the browser route");
assert.match(control, /const outboundPairings = new Map/, "outbound approval secrets should remain server-side");
assert.match(control, /outboundPairings\.delete\(operationId\)/, "approval secrets should be discarded after expiry or delivery");
assert.match(control, /localDaemonTarget\(\)/, "local device configuration should not accidentally target a configured remote hub");
assert.match(control, /protocolVersion: FLEET_PROTOCOL/, "pairing should negotiate the pinned fleet protocol");
assert.match(control, /\/fleet\/challenges/, "a discovered trusted device should begin signed reconnect with a challenge");
assert.match(control, /\/fleet\/local-credentials\/.*\/proof/, "reconnect proofs should be derived inside the local daemon");
assert.match(control, /\/fleet\/reconnect/, "refresh should complete authenticated reconnect without browser-held credentials");
assert.match(control, /\/api\/v1\/fleet\/trusted-nodes\//, "revocation should use the versioned Coven endpoint");
assert.match(control, /COVEN_DAEMON_TCP: `127\.0\.0\.1:\$\{FLEET_PORT\}`/, "Fleet activation should restart Coven with a loopback-only TCP listener");
assert.match(control, /COVEN_DAEMON_ALLOW_HOST: tailnetIp/, "the daemon should allow only this device's resolved tailnet address");
assert.match(control, /\["serve", "--bg", `--tcp=\$\{FLEET_PORT\}`/, "Fleet activation should publish exactly port 8787 through Tailscale Serve");
assert.match(control, /\["serve", `--tcp=\$\{FLEET_PORT\}`, "off"\]/, "Fleet stop should withdraw only the owned Tailscale port");
assert.doesNotMatch(control, /tailscale[\s\S]{0,80}serve[\s\S]{0,80}reset/, "Fleet lifecycle must preserve unrelated Tailscale Serve routes");
assert.match(control, /windowsHide: true/g, "Windows transport subprocesses should never open a console window");

assert.equal(fleetPortState('{"TCP":{}}'), "available");
assert.equal(fleetPortState('warning from tailscale\n{"TCP":{"8787":{"TCPForward":"127.0.0.1:8787"}}}'), "owned");
assert.equal(fleetPortState('{"TCP":{"8787":{"HTTPS":true}}}'), "conflict");
assert.equal(fleetPortState('{"TCP":{"8787":{"TCPForward":"127.0.0.1:9999"}}}'), "conflict");
assert.throws(() => fleetPortState("not json"), /unreadable status/);
assert.match(control, /\["serve", "status", "--json"\]/, "Fleet lifecycle should inspect existing Serve routes before mutation");
assert.match(control, /\/fleet\/jobs\/claim/, "a shared executor should pull jobs from its authenticated hub");
assert.match(control, /\/fleet\/local-jobs\/run/, "claimed work should execute through the local Coven daemon");
assert.match(control, /\/fleet\/jobs\/complete/, "executor results should return to the authenticated hub");
assert.match(control, /authenticatedRemotePayload/, "job claims and results should use directional credential proofs");

// Rendering Settings → Fleet issued a GET that called ensureFleetTransport(),
// which shells out to `coven daemon restart`. When another process owns port
// 8787 (WSL's wslrelay routinely does on Windows) the advertisement probe can
// never succeed, so every visit to the screen bounced the local daemon and the
// Daemon panel then reported "Offline". A read must not mutate the daemon.
const snapshotBody = control.slice(
  control.indexOf("export async function fleetSnapshot()"),
  control.indexOf("async function authenticatedRemotePayload"),
);
assert.ok(snapshotBody.length > 0, "fleetSnapshot should still be defined");
// Compare against code only: the comment above explains the regression by name,
// and must not itself satisfy the guard.
const snapshotCode = snapshotBody.replace(/^\s*\/\/.*$/gm, "");
assert.doesNotMatch(
  snapshotCode,
  /ensureFleetTransport\(/,
  "reading the fleet snapshot must never restart the daemon — Start/Restart are the explicit repair",
);
assert.match(
  snapshotBody,
  /localFleetTransportState\(\)/,
  "the snapshot should report transport state instead of provisioning it",
);
assert.match(
  control,
  /if \(state === "conflict"\) throw new Error\(fleetTransportConflictMessage\(\)\)/,
  "a foreign listener on the fleet port should be named, not answered with a daemon restart",
);
assert.match(
  control,
  /portAcceptsConnections/,
  "transport state should distinguish an absent listener from a foreign one",
);

console.log("fleet-control.test.ts: ok");
