import { z } from "zod";

import { DEFAULT_RANKING_CONFIG, type RankingConfig } from "./config.ts";

/**
 * rank-4: the editor chooses how many promos they want, and the amount of
 * detailed evaluation follows from that number instead of being fixed.
 *
 * - The quick screen still reads every candidate, so coverage does not shrink.
 * - Detailed evaluation starts with a selection sized to the request, keeps the
 *   moment-type floors and a random exploration sample, and then, for larger
 *   requests, continues in batches in screening order until enough distinct clips
 *   pass the quality gates or no candidates are left.
 * - Head-to-head comparison stays bounded: at most `MAX_FINALISTS` finalists, each
 *   compared with its nearest neighbours in both orders, as in rank-3. Promos
 *   below the finalists are ordered by their individual scores and say so.
 *
 * At 10 promos every number below equals rank-3, so the accepted rank-3 settings
 * are one point of this plan. rank-3 itself stays as written for the command line.
 */
export const ADAPTIVE_RANKING_VERSION = "rank-4";

/** A server-side ceiling well above any show we have seen (the supplied pack has 278 candidates). */
export const MAX_PROMOS = 500;
export const DEFAULT_PROMOS = 10;
export const MAX_FINALISTS = 32;

export const promoCountSchema = z.number().int().min(1).max(MAX_PROMOS);

export type PlannedConfig = RankingConfig & {
  /** How many promos the editor asked for. */
  requested: number;
  /** Detailed evaluation continues in batches until this many distinct clips are eligible. */
  progressive: { minBatch: number };
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function planRankingConfig(requested: number): PlannedConfig {
  const n = promoCountSchema.parse(requested);
  const base = DEFAULT_RANKING_CONFIG;
  // rank-3 chose 80 clips by screening priority for 10 promos: 8 per promo, with at least 24.
  const shortlist = Math.max(24, 8 * Math.min(n, 10));
  return {
    ...base,
    version: ADAPTIVE_RANKING_VERSION,
    requested: n,
    screening: {
      ...base.screening,
      shortlist,
      // rank-3 explored 12 extra clips for 80 chosen ones: 15%.
      explore: Math.round(shortlist * 0.15),
      // Giving every episode a detailed read is worth it when the list is long enough to use it.
      episodeFloor: n >= 10,
    },
    // rank-3 considered corrections for the top 30 and judged at most 12: 3 and 1.2 per promo.
    corrections: { considerTop: 3 * n, maxPerRun: Math.max(4, Math.ceil(1.2 * n)) },
    pairwise: { ...base.pairwise, finalists: clamp(n + 6, 8, MAX_FINALISTS) },
    diversity: { ...base.diversity, top: n },
    progressive: { minBatch: 16 },
  };
}
