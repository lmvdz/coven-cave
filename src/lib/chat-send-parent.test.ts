import assert from "node:assert/strict";
import test from "node:test";

import { durableSendParentId } from "./chat-send-parent.ts";

test("a new send skips a rejected optimistic user/assistant pair", () => {
  const turns = [
    { id: "durable-assistant", role: "assistant" },
    { id: "optimistic-user", parentId: "durable-assistant", role: "user" },
    {
      id: "optimistic-assistant",
      parentId: "optimistic-user",
      role: "assistant",
      lifecycle: "error",
    },
  ];

  assert.equal(durableSendParentId(turns, "optimistic-assistant"), "durable-assistant");
});

test("a durable active leaf remains the next send parent", () => {
  assert.equal(
    durableSendParentId(
      [{ id: "assistant", parentId: "user", role: "assistant", lifecycle: "complete" }],
      "assistant",
    ),
    "assistant",
  );
});

test("a rejected first follow-up returns the root branch point", () => {
  assert.equal(
    durableSendParentId(
      [
        { id: "optimistic-user", parentId: null, role: "user" },
        { id: "optimistic-assistant", parentId: "optimistic-user", role: "assistant", lifecycle: "error" },
      ],
      "optimistic-assistant",
    ),
    null,
  );
});
