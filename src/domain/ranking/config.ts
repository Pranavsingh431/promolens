import {
  CRITERIA,
  ESSENTIAL_CRITERIA,
  KEEP_MINIMUM,
  type CriterionId,
} from "../evaluation/rubric.ts";

/**
 * Ranking configuration. Every number here is a starting hypothesis, not a
 * measured predictor of promo performance. Change the version whenever a value
 * changes, so outputs from different settings are never mixed up.
 *
 * Model judgments are cached by what the model saw (clip, prompt, schema,
 * model). Scores, gates, ranks, and the shortlist are always recomputed from
 * those judgments with the current configuration, so changing a weight or a
 * threshold can never reuse an old score.
 */

/**
 * rank-1: first development pilot. rank-2: every finalist gets the same
 * number of comparisons, and a pair judged twice counts once (see pairwise.ts).
 * rank-3: every pair is judged in both orders, because the judge measurably
 * favoured the clip shown second; a clip that retells a picked clip's story
 * becomes an alternate even with no shared footage; refusals are explicit
 * states and are never sent again unless asked. Outputs from rank-2 stay as
 * written and are not comparable to rank-3 without saying so.
 */
export const RANKING_VERSION = "rank-3";

export type Weights = Record<CriterionId, number>;

export type RankingConfig = {
  version: string;
  /** Initial weights for the editorial score. Hypotheses, not fitted values. */
  weights: Weights;
  /** Every essential criterion must reach this rating for a clip to be shortlisted. */
  gateMinimum: number;
  windows: {
    /** The opening the hook must live in. */
    hookMs: number;
    /** The final stretch the cliffhanger must live in. */
    endingMs: number;
    /** Outside events shown to the editorial stage around each edge (count and time limit). */
    contextEvents: number;
    contextMs: number;
  };
  screening: {
    /** Candidates sent to detailed assessment by screening priority. */
    shortlist: number;
    /** Best candidates of each moment type always kept, so quiet or visual moments survive. */
    perTypeFloor: number;
    /** Every episode keeps its best candidate for detailed assessment. */
    episodeFloor: boolean;
    /** Seeded random sample of screened-out candidates that still gets detailed assessment. */
    explore: number;
    seed: number;
  };
  boundaries: {
    /** A spoken line cut by at least this much, or this share, is a real editorial problem. */
    substantialCutMs: number;
    substantialCutShare: number;
  };
  corrections: {
    /** Only candidates this high in the individual ranking get their correction evaluated. */
    considerTop: number;
    maxPerRun: number;
  };
  pairwise: {
    /** Strongest distinct eligible candidates compared head to head. */
    finalists: number;
    /** Each finalist gets 2 x window comparisons, with the nearest finalists in score order first. */
    window: number;
    /** Share of pairs also judged with the clips swapped. 1 cancels position bias in every pair. */
    repeatShare: number;
    /** Finalists overlapping a stronger finalist at least this much are not compared. */
    distinctSimilarity: number;
    /** Virtual tied games against a neutral anchor that keep Bradley-Terry strengths finite. */
    prior: number;
    seed: number;
  };
  diversity: {
    top: number;
    /** A clip at least this similar to a selected clip is an alternate, not a new pick. */
    redundancy: number;
    /**
     * Text similarity (see narrative.ts) at which two clips with no shared footage count as the
     * same story beat. 0.25 sits in the widest gap of the distribution seen on non-held-out
     * clips: five pairs at 0.285 or more, each the same incident, then nothing until 0.232.
     * It comes from one show, so treat it as a working value until reviewers have rated repeats.
     */
    narrativeRepeat: number;
    /** Weight on rank position versus novelty. 1 means rank order only. */
    lambda: number;
    /** How many positions ahead a more novel clip may be pulled from. */
    lookahead: number;
  };
};

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
  version: RANKING_VERSION,
  weights: { hook: 0.3, cliffhanger: 0.25, clarity: 0.2, emotion: 0.15, boundaries: 0.1 },
  gateMinimum: KEEP_MINIMUM,
  windows: { hookMs: 3_000, endingMs: 3_000, contextEvents: 3, contextMs: 8_000 },
  screening: { shortlist: 80, perTypeFloor: 2, episodeFloor: true, explore: 12, seed: 4401 },
  boundaries: { substantialCutMs: 1_000, substantialCutShare: 0.3 },
  corrections: { considerTop: 30, maxPerRun: 12 },
  pairwise: {
    finalists: 16,
    window: 3,
    repeatShare: 1,
    distinctSimilarity: 0.5,
    prior: 1,
    seed: 4402,
  },
  diversity: { top: 10, redundancy: 0.5, narrativeRepeat: 0.25, lambda: 0.8, lookahead: 4 },
};

export { CRITERIA, ESSENTIAL_CRITERIA };

/** Throws when a configuration could not produce a sensible ranking. */
export function assertValidConfig(config: RankingConfig): void {
  const ids = CRITERIA.map((c) => c.id);
  const sum = ids.reduce((total, id) => total + config.weights[id], 0);
  if (ids.some((id) => !(config.weights[id] >= 0)) || Math.abs(sum - 1) > 1e-9) {
    throw new RangeError("Weights must be non-negative and add up to 1.");
  }
  if (!Number.isInteger(config.gateMinimum) || config.gateMinimum < 0 || config.gateMinimum > 4) {
    throw new RangeError("The gate minimum must be a rating from 0 to 4.");
  }
  const positive = [
    config.windows.hookMs,
    config.windows.endingMs,
    config.diversity.top,
    config.pairwise.window,
  ];
  if (positive.some((n) => !(n > 0))) throw new RangeError("Windows and sizes must be positive.");
  for (const share of [
    config.pairwise.repeatShare,
    config.diversity.lambda,
    config.diversity.redundancy,
    config.diversity.narrativeRepeat,
  ]) {
    if (!(share >= 0 && share <= 1)) throw new RangeError("Shares must be between 0 and 1.");
  }
}
