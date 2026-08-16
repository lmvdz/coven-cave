/**
 * Spoken-register rewrite for Research podcast narration.
 *
 * Stages 1 and 4 of the prosody campaign fixed *delivery*: splitting a long
 * unit into breath units removed 37% of its pitch declination, and giving each
 * segment its neighbours as context removed 94% of the slope. What they cannot
 * fix is *register* — the extracted text is still a document. It carries
 * nominalizations, stacked noun phrases before a verb, and no discourse
 * markers, because it was written to be read with the eye.
 *
 * This module rewrites that text into speech. It is the only part of the
 * pipeline that relaxes the extractive rule, so it is fenced on both sides:
 * the rewrite never sees the mission markdown (only already-extracted units,
 * so it cannot reintroduce material extraction deliberately dropped), and every
 * number, proper noun and citation anchor in the source must survive into the
 * result or the rewrite is discarded.
 *
 * A failed check falls back to the extractive text and still renders. It never
 * fails the job: a podcast that reads like a document is a worse podcast, but a
 * podcast that misstates a finding is a broken one, and an outage is worse than
 * either.
 */

/** A number as spoken or written: 27, 1.5, 13,500, 4%, 2026. */
const NUMBER_RE = /\d+(?:[.,]\d+)*%?/g;
/**
 * Name detection, in two passes, because a capital letter means different
 * things depending on where it sits.
 *
 * A capitalized run of two or more words is a name wherever it appears,
 * sentence-initial included ("Diagram Design is not the default choice"). A
 * lone capitalized word counts only when it is *not* sentence-initial: every
 * sentence opens with a capital, and requiring "So" or "But" to survive would
 * reject every genuine restructuring.
 *
 * The residual gap is deliberate and worth stating plainly: a one-word name
 * appearing only at the start of a sentence is not protected here. The
 * alternative — a stoplist of English sentence openers — fails less
 * predictably, and a human reviews the rewrite before it renders.
 */
const CAPITALIZED_WORD = "[A-Z][A-Za-z0-9]*(?:[-/][A-Za-z0-9]+)*";
const PROPER_NOUN_SEQUENCE_RE = new RegExp(
  `\\b${CAPITALIZED_WORD}(?:\\s+${CAPITALIZED_WORD})+\\b`,
  "g",
);
const PROPER_NOUN_RE = new RegExp(
  `(?<![.!?…]\\s|^)\\b(${CAPITALIZED_WORD})\\b`,
  "gm",
);
/** Source-ledger anchors the drafter leaves in place, e.g. S1, C2, F1.1. */
const CITATION_ANCHOR_RE = /\b[SCF]\d{1,3}(?:\.\d+)?\b/g;

export type RewriteFidelityFailure = {
  kind: "number" | "proper-noun" | "citation";
  token: string;
};

/**
 * Tokens that must survive a rewrite. Case-sensitive for names, exact for
 * numbers: "27-type" becoming "twenty-seven type" is a fidelity failure here
 * even though a listener would not notice, because the check cannot tell that
 * transformation apart from a dropped digit.
 */
export function fidelityTokens(text: string): {
  numbers: string[];
  properNouns: string[];
  citations: string[];
} {
  const numbers = [...text.matchAll(NUMBER_RE)].map((match) => match[0]);
  const citations = [...text.matchAll(CITATION_ANCHOR_RE)].map((match) => match[0]);
  const citationSet = new Set(citations);
  const sequences = [...text.matchAll(PROPER_NOUN_SEQUENCE_RE)].map((match) => match[0]);
  const singles = [...text.matchAll(PROPER_NOUN_RE)].map((match) => match[1]);
  const properNouns = [...sequences, ...singles]
    // A citation anchor is already covered by its own class; counting it twice
    // would report one missing token as two failures.
    .filter((token) => !citationSet.has(token))
    // A word already required as part of a longer name needs no separate entry.
    .filter(
      (token, _index, all) =>
        !all.some(
          (other) => other !== token && other.includes(" ") && other.includes(token),
        ),
    );
  return { numbers, properNouns, citations };
}

/**
 * Every token in `source` that `rewritten` dropped.
 *
 * Multiplicity is deliberately ignored: a rewrite that says "27 types" once
 * where the source said it twice has lost nothing a listener can hear, and
 * requiring equal counts would reject almost every genuine improvement.
 */
export function fidelityFailures(
  source: string,
  rewritten: string,
): RewriteFidelityFailure[] {
  const wanted = fidelityTokens(source);
  const failures: RewriteFidelityFailure[] = [];
  const seen = new Set<string>();
  const check = (kind: RewriteFidelityFailure["kind"], tokens: string[]) => {
    for (const token of tokens) {
      const key = `${kind}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!rewritten.includes(token)) failures.push({ kind, token });
    }
  };
  check("number", wanted.numbers);
  check("citation", wanted.citations);
  check("proper-noun", wanted.properNouns);
  return failures;
}

export const REWRITE_SYSTEM_PROMPT = [
  "Rewrite each narration unit so it sounds spoken rather than read, then return them in order.",
  "",
  "Preserve every claim exactly. Do not add a fact, a number, a name, an opinion, or a",
  "conclusion the source does not state. Do not drop one either. You are changing how the",
  "text sounds, never what it says.",
  "",
  "Make it speakable:",
  "- Break stacked noun phrases and subordinate clauses into short declarative sentences.",
  "- Front-load the subject and verb; keep most sentences under about twelve words.",
  "- Vary sentence length deliberately. Short fragments are welcome as emphasis.",
  "- Replace nominalizations with verbs, and formal register with plain words.",
  "- Discourse markers at transitions are welcome: So, But, Here's the thing, Look.",
  "- Keep every number, proper noun, and source anchor (S1, C2) written exactly as given.",
].join("\n");

export const REWRITE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["units"],
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "text"],
        properties: {
          index: { type: "integer", minimum: 0 },
          text: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

/** Runs the rewrite model. Injected so the pipeline can be tested offline. */
export type RewriteRunner = (input: {
  prompt: string;
  schema: typeof REWRITE_OUTPUT_SCHEMA;
}) => Promise<string>;

export type RewriteResult = {
  units: string[];
  applied: boolean;
  /** Why the extractive text was kept. Absent when the rewrite applied. */
  reason?: string;
  failures?: RewriteFidelityFailure[];
};

function parseUnits(raw: string, expected: number): string[] | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const units = (payload as { units?: unknown })?.units;
  if (!Array.isArray(units) || units.length !== expected) return null;
  const ordered: string[] = new Array(expected).fill("");
  for (const entry of units) {
    const item = entry as { index?: unknown; text?: unknown };
    if (
      typeof item.index !== "number" ||
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      item.index >= expected ||
      typeof item.text !== "string" ||
      !item.text.trim()
    ) {
      return null;
    }
    ordered[item.index] = item.text.trim();
  }
  return ordered.every((text) => text.length > 0) ? ordered : null;
}

/**
 * Rewrite extracted narration units into spoken register, or return them
 * untouched with the reason it was not safe to.
 */
export async function rewriteNarrationForSpeech(
  units: readonly string[],
  run: RewriteRunner,
): Promise<RewriteResult> {
  if (units.length === 0) return { units: [], applied: false, reason: "no narration units" };
  const numbered = units
    .map((text, index) => `<<unit ${index}>>\n${text}`)
    .join("\n\n");
  const prompt = `${REWRITE_SYSTEM_PROMPT}\n\n${numbered}`;

  let raw: string;
  try {
    raw = await run({ prompt, schema: REWRITE_OUTPUT_SCHEMA });
  } catch (error) {
    return {
      units: [...units],
      applied: false,
      reason: `rewrite runner failed: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }

  const rewritten = parseUnits(raw, units.length);
  if (!rewritten) {
    return { units: [...units], applied: false, reason: "rewrite response did not match the schema" };
  }

  // Fidelity is checked per unit, not across the whole script: a rewrite that
  // moved a number from one unit into another would keep the episode's claims
  // intact but attach them to the wrong finding.
  const failures: RewriteFidelityFailure[] = [];
  for (const [index, source] of units.entries()) {
    failures.push(...fidelityFailures(source, rewritten[index]));
  }
  if (failures.length > 0) {
    return {
      units: [...units],
      applied: false,
      reason: `rewrite dropped ${failures.length} source token(s)`,
      failures,
    };
  }
  return { units: rewritten, applied: true };
}
