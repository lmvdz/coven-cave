// ElevenLabs shared constants + validators — dependency-light on purpose so
// the server TTS proxy (app/api/voice/elevenlabs/tts) can import them without
// dragging the provider's client-side import graph (familiar-stream → "@/…")
// into a route module.

/** Balanced quality/latency default; users override per-familiar via the
 *  Studio "Voice model" field. */
export const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_turbo_v2_5";

/**
 * A render seed derived from the generation id, so re-rendering one generation
 * reproduces its own audio instead of drifting.
 *
 * Verified against the provider: two seeded requests for identical text return
 * byte-identical *lengths* (identical sample counts, so identical duration and
 * pacing) while two unseeded requests differ by ~6%. Without this, no two
 * renders are comparable, and any before/after measurement is confounded by
 * run variance — which is exactly what happened while measuring the cadence
 * change. The waveform is not bit-identical; the timing is, which is the part
 * prosody work needs to hold still.
 */
export function researchRenderSeed(generationId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < generationId.length; index += 1) {
    hash ^= generationId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  // ElevenLabs accepts 0 … 4294967295; keep it inside a safe unsigned range.
  return hash >>> 0;
}

/** "Rachel", ElevenLabs' long-standing premade voice — a stable public id so
 *  the provider speaks out of the box before the user picks a voice. */
export const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/** Per-utterance cap shared by the client mouth (clamps before posting) and
 *  the proxy (hard 400 over it) — sentence chunks are small; this only guards
 *  degenerate unterminated tails and direct callers. */
export const ELEVENLABS_TTS_MAX_CHARS = 2_000;

/** Voice ids are opaque alphanumeric handles that get interpolated into the
 *  upstream URL path — the strict shape is the injection barrier. */
export function isValidElevenLabsVoiceId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9]{8,64}$/.test(id);
}

export function isValidElevenLabsModelId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9_]{1,64}$/.test(id);
}

// ── Delivery → provider voice settings ───────────────────────────────────────

/** The `voice_settings` block ElevenLabs accepts on a text-to-speech request. */
export type ElevenLabsVoiceSettings = {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
};

/**
 * Resolve a named delivery into provider settings.
 *
 * Sending no `voice_settings` at all leaves every render on whatever default
 * the voice was saved with, which is neither recorded in the generation nor
 * reproducible later — a podcast rendered twice from one config could differ
 * because someone edited the voice in the ElevenLabs dashboard. Naming the
 * delivery makes the render self-describing.
 *
 * `stability` trades consistency against expressiveness: high holds an even
 * register and is what a dense technical read wants, low lets the model move
 * more and suits narrative. `style` exaggerates the source voice's own
 * characteristics and costs latency, so it stays at 0 except where it earns
 * its keep.
 */
export function elevenLabsVoiceSettings(
  delivery: "natural" | "steady" | "expressive" = "natural",
): ElevenLabsVoiceSettings {
  switch (delivery) {
    case "steady":
      return {
        stability: 0.75,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
      };
    case "expressive":
      return {
        stability: 0.35,
        similarity_boost: 0.75,
        style: 0.45,
        use_speaker_boost: true,
      };
    default:
      return {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
      };
  }
}

// ── Account catalog (saved voices + available models) ────────────────────────

export type ElevenLabsVoiceOption = { id: string; name: string; category?: string };
export type ElevenLabsModelOption = { id: string; name: string };

/** Map the /v1/voices payload (the voices saved in the user's library) into
 *  dropdown options. Defensive: entries with malformed ids are dropped, and a
 *  missing name falls back to the id so every option stays selectable. */
export function parseElevenLabsVoices(payload: unknown): ElevenLabsVoiceOption[] {
  const voices = (payload as { voices?: unknown })?.voices;
  if (!Array.isArray(voices)) return [];
  const out: ElevenLabsVoiceOption[] = [];
  for (const raw of voices) {
    const entry = raw as { voice_id?: unknown; name?: unknown; category?: unknown };
    if (!isValidElevenLabsVoiceId(entry.voice_id)) continue;
    const name =
      typeof entry.name === "string" && entry.name.trim()
        ? entry.name.trim()
        : entry.voice_id;
    out.push({
      id: entry.voice_id,
      name,
      ...(typeof entry.category === "string" && entry.category
        ? { category: entry.category }
        : {}),
    });
  }
  return out;
}

/** Map the /v1/models payload into dropdown options, keeping only models that
 *  can synthesize speech (the whole point of picking one here). */
export function parseElevenLabsModels(payload: unknown): ElevenLabsModelOption[] {
  if (!Array.isArray(payload)) return [];
  const out: ElevenLabsModelOption[] = [];
  for (const raw of payload) {
    const entry = raw as {
      model_id?: unknown;
      name?: unknown;
      can_do_text_to_speech?: unknown;
    };
    if (!isValidElevenLabsModelId(entry.model_id)) continue;
    if (entry.can_do_text_to_speech === false) continue;
    const name =
      typeof entry.name === "string" && entry.name.trim()
        ? entry.name.trim()
        : entry.model_id;
    out.push({ id: entry.model_id, name });
  }
  return out;
}
