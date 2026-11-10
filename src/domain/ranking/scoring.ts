import {
  CRITERIA,
  ESSENTIAL_CRITERIA,
  type CriterionId,
  type Ratings,
} from "../evaluation/rubric.ts";
import type { RankingConfig, Weights } from "./config.ts";
import type { ColdViewerAnswer, ColdViewerResponse } from "./prompts/cold-viewer-v1.ts";
import type { EditorialResponse } from "./prompts/editorial-v1.ts";
import { normalizeRef } from "./prompts/render.ts";
import type { ClipEvent, ClipView, LineCut } from "./windows.ts";

/**
 * Deterministic scoring. Models give ratings with evidence; code checks the
 * evidence against the clip and can only lower a rating, never raise it.
 * Every cap is recorded with its reason, so a reviewer can see why a score is
 * what it is.
 */

export type CriterionResult = {
  /** Rating after the checks below. Used for every score and gate. */
  rating: number;
  /** What the model said. */
  raw: number;
  caps: string[];
};

function capped(raw: number, caps: ReadonlyArray<readonly [number, string]>): CriterionResult {
  let rating = raw;
  const reasons: string[] = [];
  for (const [limit, reason] of caps) {
    if (rating > limit) {
      rating = limit;
      reasons.push(reason);
    } else if (raw > limit) {
      reasons.push(reason);
    }
  }
  return { rating, raw, caps: reasons };
}

/** Splits cited references into those that exist in the allowed set and those that do not. */
export function checkRefs(
  cited: readonly string[],
  allowed: ReadonlyMap<string, ClipEvent>,
): { valid: ClipEvent[]; invalid: string[] } {
  const valid: ClipEvent[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of cited) {
    const ref = normalizeRef(raw);
    if (seen.has(ref)) continue;
    seen.add(ref);
    const event = allowed.get(ref);
    if (event) valid.push(event);
    else invalid.push(raw);
  }
  return { valid, invalid };
}

const byRef = (events: readonly ClipEvent[]) => new Map(events.map((e) => [e.ref, e]));

export type ClarityResult = CriterionResult & {
  /** Answers whose certainty was lowered because they cited no event in the clip. */
  unsupported: Array<"involved" | "happening" | "stakes" | "openQuestion">;
  invalidRefs: string[];
  /** Certainty after the evidence check. */
  certainty: Record<
    "involved" | "happening" | "stakes" | "openQuestion",
    ColdViewerAnswer["certainty"]
  >;
  essentialMissing: number;
};

/**
 * Clarity from the cold-viewer answers. An answer that claims to be clear or
 * partly clear without citing any event in the clip is treated as unclear,
 * because a confident explanation the clip does not support is not
 * comprehension. Then:
 * - what is happening, or what is at stake, unclear: at most 1;
 * - who is involved unclear: at most 2;
 * - any essential missing context: at most 2;
 * - two or more of who, what, and stakes only partly clear: at most 2;
 * - a viewer would not understand enough to care: at most 2.
 */
export function deriveClarity(answer: ColdViewerResponse, view: ClipView): ClarityResult {
  const refs = byRef(view.events);
  const keys = ["involved", "happening", "stakes", "openQuestion"] as const;
  const certainty = {} as ClarityResult["certainty"];
  const unsupported: ClarityResult["unsupported"] = [];
  const invalidRefs: string[] = [];
  for (const key of keys) {
    const { valid, invalid } = checkRefs(answer[key].evidence, refs);
    invalidRefs.push(...invalid);
    const claimed = answer[key].certainty;
    if (claimed !== "unclear" && valid.length === 0) {
      certainty[key] = "unclear";
      unsupported.push(key);
    } else {
      certainty[key] = claimed;
    }
  }
  const essentialMissing = answer.missingContext.filter((m) => m.essential).length;
  const partial = (["involved", "happening", "stakes"] as const).filter(
    (k) => certainty[k] === "partial",
  ).length;

  const caps: Array<[number, string]> = [];
  if (certainty.happening === "unclear") caps.push([1, "what-is-happening-unclear"]);
  if (certainty.stakes === "unclear") caps.push([1, "stakes-unclear"]);
  if (certainty.involved === "unclear") caps.push([2, "who-is-involved-unclear"]);
  if (essentialMissing > 0) caps.push([2, "essential-context-missing"]);
  if (partial >= 2) caps.push([2, "mostly-partial-understanding"]);
  if (answer.wouldCare.verdict === "no") caps.push([2, "would-not-care"]);
  const result = capped(answer.clarity, caps);

  return { ...result, unsupported, invalidRefs, certainty, essentialMissing };
}

export type EditorialResult = {
  hook: CriterionResult;
  cliffhanger: CriterionResult;
  emotion: CriterionResult;
  boundaries: CriterionResult;
  evidence: { hook: ClipEvent[]; cliffhanger: ClipEvent[]; emotion: ClipEvent[] };
  invalidRefs: string[];
  /** Cited events that exist but lie outside the window they were cited for. */
  outOfWindowRefs: string[];
};

/**
 * Checks an editorial judgment against the clip:
 * - hook evidence must be OPENING events, or the hook is at most 1;
 * - a hook that needs prior context is at most 3;
 * - cliffhanger evidence must be ENDING events, or the cliffhanger is at most 1;
 * - a declared false cliffhanger, or no unresolved tension, is at most 1;
 * - emotion with no evidence in the clip is at most 1;
 * - an edge that cuts a substantial part of a spoken line keeps boundaries at most 2.
 */
export function applyEditorialRules(
  judgment: EditorialResponse,
  view: ClipView,
  cuts: readonly LineCut[],
): EditorialResult {
  const all = byRef(view.events);
  const opening = byRef(view.opening);
  const ending = byRef(view.ending);
  const invalidRefs: string[] = [];
  const outOfWindowRefs: string[] = [];

  const inWindow = (cited: readonly string[], window: ReadonlyMap<string, ClipEvent>) => {
    const { valid, invalid } = checkRefs(cited, all);
    invalidRefs.push(...invalid);
    const inside = valid.filter((e) => window.has(e.ref));
    outOfWindowRefs.push(...valid.filter((e) => !window.has(e.ref)).map((e) => e.ref));
    return inside;
  };

  const hookEvidence = inWindow(judgment.hook.evidence, opening);
  const cliffEvidence = inWindow(judgment.cliffhanger.evidence, ending);
  const emotionEvidence = checkRefs(judgment.emotion.evidence, all);
  invalidRefs.push(...emotionEvidence.invalid);

  const hookCaps: Array<[number, string]> = [];
  if (hookEvidence.length === 0) hookCaps.push([1, "no-hook-evidence-in-opening"]);
  if (judgment.hook.needsPriorContext) hookCaps.push([3, "hook-needs-prior-context"]);

  const cliffCaps: Array<[number, string]> = [];
  if (cliffEvidence.length === 0) cliffCaps.push([1, "no-cliffhanger-evidence-in-ending"]);
  if (judgment.cliffhanger.falseCliffhanger !== "none") {
    cliffCaps.push([1, `false-cliffhanger:${judgment.cliffhanger.falseCliffhanger}`]);
  }
  if (judgment.cliffhanger.tension === "none") cliffCaps.push([1, "nothing-left-unresolved"]);

  const emotionCaps: Array<[number, string]> =
    emotionEvidence.valid.length === 0 ? [[1, "no-emotion-evidence"]] : [];
  const boundaryCaps: Array<[number, string]> = cuts.some((c) => c.substantial)
    ? [[2, "cuts-spoken-line"]]
    : [];

  const hook = capped(judgment.hook.rating, hookCaps);
  const cliffhanger = capped(judgment.cliffhanger.rating, cliffCaps);
  const emotion = capped(judgment.emotion.rating, emotionCaps);
  const boundaries = capped(judgment.boundaries.rating, boundaryCaps);

  return {
    hook,
    cliffhanger,
    emotion,
    boundaries,
    evidence: { hook: hookEvidence, cliffhanger: cliffEvidence, emotion: emotionEvidence.valid },
    invalidRefs,
    outOfWindowRefs,
  };
}

/** Weighted editorial score from 0 to 100. A ranking aid, not a probability of anything. */
export function weightedScore(ratings: Ratings, weights: Weights): number {
  const sum = CRITERIA.reduce((total, c) => total + weights[c.id] * ratings[c.id], 0);
  return Math.round(sum * 25 * 100) / 100;
}

export type Gate = { pass: boolean; failed: CriterionId[] };

/** Every essential criterion (hook, cliffhanger, clarity) must reach the minimum. */
export function essentialGate(ratings: Ratings, minimum: number): Gate {
  const failed = ESSENTIAL_CRITERIA.filter((id) => ratings[id] < minimum);
  return { pass: failed.length === 0, failed };
}

export type Tier = "below-gate" | "usable" | "strong" | "excellent";

/**
 * Same bands as the human rubric's overall assessment, so model and human
 * results read the same way: usable (weakest essential 2), strong (all
 * essentials 3+), excellent (strong, two essentials at 4, boundaries 3+).
 */
export function tierOf(ratings: Ratings, minimum: number): Tier {
  if (!essentialGate(ratings, minimum).pass) return "below-gate";
  const essentials = ESSENTIAL_CRITERIA.map((id) => ratings[id]);
  if (Math.min(...essentials) < 3) return "usable";
  const fours = essentials.filter((r) => r === 4).length;
  return fours >= 2 && ratings.boundaries >= 3 ? "excellent" : "strong";
}

export const TIER_ORDER: Record<Tier, number> = {
  excellent: 3,
  strong: 2,
  usable: 1,
  "below-gate": 0,
};

export type Scored = {
  ratings: Ratings;
  score: number;
  gate: Gate;
  tier: Tier;
};

export function scoreRatings(
  ratings: Ratings,
  config: Pick<RankingConfig, "weights" | "gateMinimum">,
): Scored {
  return {
    ratings,
    score: weightedScore(ratings, config.weights),
    gate: essentialGate(ratings, config.gateMinimum),
    tier: tierOf(ratings, config.gateMinimum),
  };
}
