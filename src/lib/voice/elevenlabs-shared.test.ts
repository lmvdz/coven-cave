import assert from "node:assert/strict";
import { test } from "node:test";

import { RESEARCH_PODCAST_MODEL_IDS } from "../research-generations.ts";
import {
  DEFAULT_ELEVENLABS_MODEL_ID,
  elevenLabsVoiceSettings,
  isValidElevenLabsModelId,
  researchRenderSeed,
} from "./elevenlabs-shared.ts";

// `research-generations.ts` is the shared client/server contract and stays free
// of provider imports, so the podcast model allowlist is declared there as a
// literal. This is the seam that keeps the two in agreement.
test("every allowlisted podcast model is a well-formed provider model id", () => {
  for (const model of RESEARCH_PODCAST_MODEL_IDS) {
    assert.ok(isValidElevenLabsModelId(model), `${model} matches the provider id shape`);
  }
  assert.ok(
    RESEARCH_PODCAST_MODEL_IDS.includes(
      DEFAULT_ELEVENLABS_MODEL_ID as (typeof RESEARCH_PODCAST_MODEL_IDS)[number],
    ),
    "the fallback model a podcast renders with is itself allowlisted",
  );
});

test("a render seed is stable per generation and spread across generations", () => {
  assert.equal(researchRenderSeed("podcast-a"), researchRenderSeed("podcast-a"));
  assert.notEqual(researchRenderSeed("podcast-a"), researchRenderSeed("podcast-b"));
  // Single-character neighbours must not collide: generation ids differ by one
  // character far more often than by many.
  assert.notEqual(researchRenderSeed("podcast-a"), researchRenderSeed("podcast-c"));
  for (const id of ["", "podcast-a", "0480d408-4bf2-4128-864a-747de5fafe5f"]) {
    const seed = researchRenderSeed(id);
    assert.ok(Number.isInteger(seed), `${id} yields an integer`);
    assert.ok(seed >= 0 && seed <= 4_294_967_295, `${id} stays in the accepted range`);
  }
});

test("named deliveries are acoustically distinct, not decoration", () => {
  const natural = elevenLabsVoiceSettings("natural");
  const steady = elevenLabsVoiceSettings("steady");
  const expressive = elevenLabsVoiceSettings("expressive");
  assert.ok(steady.stability > natural.stability);
  assert.ok(expressive.stability < natural.stability);
  assert.ok(expressive.style > natural.style);
  assert.deepEqual(elevenLabsVoiceSettings(), natural, "the default is natural");
  for (const settings of [natural, steady, expressive]) {
    assert.ok(settings.stability >= 0 && settings.stability <= 1);
    assert.ok(settings.similarity_boost >= 0 && settings.similarity_boost <= 1);
    assert.ok(settings.style >= 0 && settings.style <= 1);
  }
});
