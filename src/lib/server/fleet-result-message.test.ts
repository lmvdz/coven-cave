import assert from "node:assert/strict";
import test from "node:test";

import { fleetExecutionFailureMessage } from "./fleet-result-message.ts";

test("missing executor harness becomes an actionable Cave-safe message", () => {
  const stderr = "private path and token\nError: harness `codex` is not available. Install it.";
  const message = fleetExecutionFailureMessage({ status: "failed", stderr }, "codex");
  assert.equal(
    message,
    "The selected Fleet executor cannot run the codex runtime. Install and sign in to codex on that device, then restart its Fleet connection.",
  );
  assert.doesNotMatch(message, /private path|token/);
});

test("unknown executor stderr is never copied into Cave-visible text", () => {
  const message = fleetExecutionFailureMessage(
    { status: "failed", stderr: "SECRET_PROVIDER_TOKEN=do-not-display" },
    "claude",
  );
  assert.match(message, /runtime exited/);
  assert.doesNotMatch(message, /SECRET|do-not-display/);
});

test("a successful empty result retains the neutral empty-response message", () => {
  assert.equal(
    fleetExecutionFailureMessage({ status: "completed" }, "codex"),
    "The executor finished without returning an assistant response.",
  );
});
