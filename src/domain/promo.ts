import { z } from "zod";

import { msSchema } from "./screenplay/schema.ts";

/**
 * Hard limits from the brief: a promo is a 20 to 60-second clip. Quality rules,
 * such as "hook within the first three seconds", are checks, not schema rules,
 * so a weak promo can still be stored and reported.
 */
export const PROMO_LIMITS = {
  minDurationMs: 20_000,
  maxDurationMs: 60_000,
} as const;

export const segmentSchema = z
  .object({
    episode: z.number().int().positive(),
    startMs: msSchema,
    endMs: msSchema,
  })
  .refine((segment) => segment.endMs > segment.startMs, {
    message: "Segment must end after it starts",
    path: ["endMs"],
  });

export type Segment = z.infer<typeof segmentSchema>;

export function totalDurationMs(segments: readonly Segment[]): number {
  return segments.reduce((sum, segment) => sum + (segment.endMs - segment.startMs), 0);
}

function overlaps(a: Segment, b: Segment): boolean {
  return a.episode === b.episode && a.startMs < b.endMs && b.startMs < a.endMs;
}

/**
 * One recommended promo, as the editor receives it. Segments are listed in
 * playback order, which does not have to be story order.
 */
export const promoSchema = z
  .object({
    id: z.string().min(1),
    rank: z.number().int().positive(),
    segments: z.array(segmentSchema).min(1),
    hook: z.string().min(1),
    cliffhanger: z.string().min(1),
    whyItWorks: z.string().min(1),
    rankReason: z.string().min(1),
  })
  .superRefine((promo, ctx) => {
    const total = totalDurationMs(promo.segments);
    if (total < PROMO_LIMITS.minDurationMs || total > PROMO_LIMITS.maxDurationMs) {
      ctx.addIssue({
        code: "custom",
        path: ["segments"],
        message: `Promo runs ${total} ms; it must run between ${PROMO_LIMITS.minDurationMs} and ${PROMO_LIMITS.maxDurationMs} ms`,
      });
    }

    promo.segments.forEach((segment, i) => {
      promo.segments.slice(i + 1).forEach((other, offset) => {
        if (overlaps(segment, other)) {
          ctx.addIssue({
            code: "custom",
            path: ["segments", i + 1 + offset],
            message: `Segment overlaps segment ${i + 1} in episode ${segment.episode}`,
          });
        }
      });
    });
  });

export type Promo = z.infer<typeof promoSchema>;
