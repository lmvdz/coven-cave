import assert from "node:assert/strict";
import test from "node:test";

import { resolveFleetParentTurnId } from "./fleet-parent-resolution.ts";

const turnIds = new Set(["durable-user", "durable-assistant"]);

test("ordinary sends replace a browser-only parent with the canonical active leaf", () => {
  assert.deepEqual(resolveFleetParentTurnId({
    turnIds,
    activeLeafId: "durable-assistant",
    requestedParentTurnId: "optimistic-assistant",
    allowCanonicalFallback: true,
  }), { ok: true, parentTurnId: "durable-assistant" });
});

test("explicit branch sends reject a missing parent", () => {
  assert.deepEqual(resolveFleetParentTurnId({
    turnIds,
    activeLeafId: "durable-assistant",
    requestedParentTurnId: "missing-branch",
    allowCanonicalFallback: false,
  }), { ok: false });
});

test("an existing explicit branch parent is preserved", () => {
  assert.deepEqual(resolveFleetParentTurnId({
    turnIds,
    activeLeafId: "durable-assistant",
    requestedParentTurnId: "durable-user",
    allowCanonicalFallback: false,
  }), { ok: true, parentTurnId: "durable-user" });
});

test("a corrupt canonical leaf remains fail-closed", () => {
  assert.deepEqual(resolveFleetParentTurnId({
    turnIds,
    activeLeafId: "missing-active-leaf",
    requestedParentTurnId: "optimistic-assistant",
    allowCanonicalFallback: true,
  }), { ok: false });
});
