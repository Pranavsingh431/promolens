import { z } from "zod";

import { PROMO_LIMITS } from "../promo.ts";
import { msSchema } from "../screenplay/schema.ts";

/**
 * A proposed promo clip. The evaluation code never looks at where a
 * candidate came from: a heuristic, a language model, or a human editor all
 * produce this same shape.
 *
 * A clip's identity is its interval set (clipKey), not its method. When two
 * methods propose the same interval, a human judgment of it counts for both.
 */

const eventIdSchema = z.string().regex(/^E\d{3,}-\d{4,}$/);

export const candidateSegmentSchema = z
  .object({
    episode: z.number().int().positive(),
    startMs: msSchema,
    endMs: msSchema,
    /** Every event that overlaps the segment, in time order. */
    eventIds: z.array(eventIdSchema),
  })
  .refine((segment) => segment.endMs > segment.startMs, {
    message: "Segment must end after it starts",
    path: ["endMs"],
  });

export const adjustmentSchema = z.object({
  segment: z.number().int().nonnegative(),
  edge: z.enum(["start", "end"]),
  fromMs: msSchema,
  toMs: msSchema,
  reason: z.string().min(1),
});

export const methodNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._:/-]{0,79}$/);

export const candidateSchema = z.object({
  /** `${method}:${clipKey}`. Stable for the same method and interval. */
  id: z.string().min(1),
  clipKey: z.string().min(1),
  method: methodNameSchema,
  /** Generator configuration version, so runs can be compared over time. */
  methodVersion: z.string().min(1),
  /** 1 is the method's first choice. Unique within one candidate set. */
  rank: z.number().int().positive(),
  /** The method's own score. Null for methods that do not score. */
  score: z.number().finite().nullable(),
  /** Segments in playback order. */
  segments: z.array(candidateSegmentSchema).min(1),
  durationMs: z.number().int().positive(),
  /** How the final segments differ from what the method first proposed. */
  adjustments: z.array(adjustmentSchema),
  /** Explainable rule codes from the generator, such as "end:question". Never script text. */
  cues: z.array(z.string().regex(/^[a-z0-9:-]+$/)),
  /** Set when this candidate is a corrected copy of another one. */
  derivedFrom: z.string().optional(),
});

export const candidateSetSchema = z.object({
  method: methodNameSchema,
  methodVersion: z.string().min(1),
  /** SHA-256 of the screenplay pack the candidates were generated from. */
  packSha256: z.string().regex(/^[0-9a-f]{64}$/),
  candidates: z.array(candidateSchema),
  /** Proposals the generator dropped, counted by reason. Nothing is dropped silently. */
  rejected: z.record(z.string(), z.number().int().nonnegative()),
  proposals: z.number().int().nonnegative(),
});

export type CandidateSegment = z.infer<typeof candidateSegmentSchema>;
export type Adjustment = z.infer<typeof adjustmentSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type CandidateSet = z.infer<typeof candidateSetSchema>;
export type Interval = { episode: number; startMs: number; endMs: number };

export const DURATION_LIMITS = PROMO_LIMITS;

/** "E012@0012340-0045670", joined with "+" for several segments. Sortable and unique. */
export function clipKey(segments: readonly Interval[]): string {
  return segments
    .map(
      (s) =>
        `E${String(s.episode).padStart(3, "0")}@${String(s.startMs).padStart(7, "0")}-${String(s.endMs).padStart(7, "0")}`,
    )
    .join("+");
}

export function parseClipKey(key: string): Interval[] {
  return key.split("+").map((part) => {
    const match = /^E(\d+)@(\d+)-(\d+)$/.exec(part);
    if (!match) throw new Error(`Invalid clip key ${key}`);
    return { episode: Number(match[1]), startMs: Number(match[2]), endMs: Number(match[3]) };
  });
}

export function intervalDurationMs(segments: readonly Interval[]): number {
  return segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
}

/**
 * Temporal intersection over union of two interval sets. Only time in the
 * same episode overlaps. Segments within one set are assumed not to overlap.
 */
export function intervalIoU(a: readonly Interval[], b: readonly Interval[]): number {
  let intersection = 0;
  for (const x of a) {
    for (const y of b) {
      if (x.episode !== y.episode) continue;
      intersection += Math.max(0, Math.min(x.endMs, y.endMs) - Math.max(x.startMs, y.startMs));
    }
  }
  const union = intervalDurationMs(a) + intervalDurationMs(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Orders candidates by score (highest first), then episode, start time, and
 * clip key, so ties always break the same way. Unscored candidates come last.
 */
export function compareCandidates(
  a: Pick<Candidate, "score" | "segments" | "clipKey">,
  b: Pick<Candidate, "score" | "segments" | "clipKey">,
): number {
  const scoreA = a.score ?? Number.NEGATIVE_INFINITY;
  const scoreB = b.score ?? Number.NEGATIVE_INFINITY;
  if (scoreA !== scoreB) return scoreB - scoreA;
  const [firstA] = a.segments;
  const [firstB] = b.segments;
  return (
    (firstA?.episode ?? 0) - (firstB?.episode ?? 0) ||
    (firstA?.startMs ?? 0) - (firstB?.startMs ?? 0) ||
    (a.clipKey < b.clipKey ? -1 : a.clipKey > b.clipKey ? 1 : 0)
  );
}

/** Returns candidates sorted with compareCandidates and ranks set to 1..n. */
export function rankCandidates<T extends Candidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort(compareCandidates).map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));
}
