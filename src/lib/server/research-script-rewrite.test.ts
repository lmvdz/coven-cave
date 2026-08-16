import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fidelityFailures,
  fidelityTokens,
  rewriteNarrationForSpeech,
  type RewriteRunner,
} from "./research-script-rewrite.ts";

const SOURCE = [
  "Its 27-type design system, strict complexity budgets, and cross-platform checks are documented in the repository S1.",
  "Diagram Design is not the default choice for dense graphs or collaborative GUI editing.",
];

const respond = (units: string[]): RewriteRunner =>
  async () => JSON.stringify({ units: units.map((text, index) => ({ index, text })) });

test("fidelity tokens cover numbers, names, and source anchors", () => {
  const tokens = fidelityTokens(SOURCE[0]);
  assert.ok(tokens.numbers.includes("27"));
  assert.ok(tokens.citations.includes("S1"));
  // A citation anchor is not also counted as a proper noun, or one dropped
  // token would be reported as two failures.
  assert.ok(!tokens.properNouns.includes("S1"));
});

test("a faithful rewrite is applied", async () => {
  const result = await rewriteNarrationForSpeech(
    SOURCE,
    respond([
      "So it ships a 27-type design system. Strict complexity budgets. Cross-platform checks too. All of it documented in the repository S1.",
      "But Diagram Design is not the default for dense graphs. Or for collaborative GUI editing.",
    ]),
  );
  assert.equal(result.applied, true);
  assert.equal(result.units.length, 2);
  assert.match(result.units[0], /^So it ships/);
});

test("a rewrite that drops a number keeps the extractive text", async () => {
  const result = await rewriteNarrationForSpeech(
    SOURCE,
    respond([
      "So it ships a rich design system, strict budgets, and cross-platform checks, all documented in the repository S1.",
      "But Diagram Design is not the default for dense graphs or collaborative GUI editing.",
    ]),
  );
  assert.equal(result.applied, false);
  assert.deepEqual(result.units, SOURCE, "the source survives verbatim");
  assert.ok(result.failures?.some((failure) => failure.token === "27"));
});

test("a rewrite that drops a name or an anchor keeps the extractive text", async () => {
  const droppedName = await rewriteNarrationForSpeech(
    SOURCE,
    respond([
      "So it ships a 27-type design system, strict budgets, and cross-platform checks, documented in the repository S1.",
      "But it is not the default for dense graphs or collaborative GUI editing.",
    ]),
  );
  assert.equal(droppedName.applied, false);
  assert.ok(
    droppedName.failures?.some((failure) => failure.token === "Diagram Design"),
    "a capitalized run is a name even at the start of a sentence",
  );

  const droppedAnchor = await rewriteNarrationForSpeech(
    SOURCE,
    respond([
      "So it ships a 27-type design system, strict budgets, and cross-platform checks, documented in the repository.",
      "But Diagram Design is not the default for dense graphs or collaborative GUI editing.",
    ]),
  );
  assert.equal(droppedAnchor.applied, false);
  assert.ok(droppedAnchor.failures?.some((failure) => failure.kind === "citation"));
});

test("moving a claim between units is a fidelity failure", async () => {
  // Checked per unit rather than across the script: an episode can keep every
  // claim and still attach one to the wrong finding.
  const result = await rewriteNarrationForSpeech(
    SOURCE,
    respond([
      "So it ships a design system, strict budgets, and cross-platform checks, documented in the repository S1.",
      "But Diagram Design — all 27 types of it — is not the default for dense graphs or collaborative GUI editing.",
    ]),
  );
  assert.equal(result.applied, false);
  assert.ok(result.failures?.some((failure) => failure.token === "27"));
});

test("a runner failure never fails the job", async () => {
  const result = await rewriteNarrationForSpeech(SOURCE, async () => {
    throw new Error("codex exec exited 1");
  });
  assert.equal(result.applied, false);
  assert.deepEqual(result.units, SOURCE);
  assert.match(result.reason ?? "", /codex exec exited 1/);
});

test("a malformed or mis-counted response never fails the job", async () => {
  for (const raw of [
    "not json",
    JSON.stringify({ units: [] }),
    JSON.stringify({ units: [{ index: 0, text: "only one" }] }),
    JSON.stringify({ units: [{ index: 0, text: "a" }, { index: 0, text: "b" }] }),
    JSON.stringify({ units: [{ index: 0, text: "a" }, { index: 1, text: "   " }] }),
  ]) {
    const result = await rewriteNarrationForSpeech(SOURCE, async () => raw);
    assert.equal(result.applied, false, raw.slice(0, 40));
    assert.deepEqual(result.units, SOURCE);
  }
});

test("an out-of-order response is reordered by index, not by arrival", async () => {
  const result = await rewriteNarrationForSpeech(SOURCE, async () =>
    JSON.stringify({
      units: [
        { index: 1, text: "But Diagram Design is not the default for dense graphs or collaborative GUI editing." },
        { index: 0, text: "So it ships a 27-type design system, strict budgets, and cross-platform checks, in the repository S1." },
      ],
    }),
  );
  assert.equal(result.applied, true);
  assert.match(result.units[0], /^So it ships/);
  assert.match(result.units[1], /^But Diagram Design/);
});

test("repeated tokens are not required to repeat in the rewrite", () => {
  // A rewrite that states a number once where the source stated it twice has
  // lost nothing a listener can hear.
  assert.deepEqual(fidelityFailures("27 types, all 27 of them", "It ships 27 types."), []);
});
