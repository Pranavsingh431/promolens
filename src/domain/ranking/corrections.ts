import {
  DURATION_LIMITS,
  clipKey,
  intervalDurationMs,
  type Candidate,
} from "../evaluation/candidate.ts";
import { checkCandidate, toSegments } from "../evaluation/structural-checks.ts";
import type { Timeline } from "../screenplay/timeline.ts";
import type { EditorialResponse } from "./prompts/editorial-v1.ts";
import { normalizeRef } from "./prompts/render.ts";
import type { ClipContext, ClipView } from "./windows.ts";

/**
 * Turns a model's proposed new start or end into a separate, checked clip.
 * The original clip is never changed. The corrected clip gets its own id and
 * cache key, and must be judged again from scratch on its own opening and
 * ending before it can be ranked.
 */

export type CorrectionResult =
  | { ok: true; candidate: Candidate; startRef: string | null; endRef: string | null }
  | { ok: false; reason: string };

export function proposeCorrection(
  original: Candidate,
  correction: EditorialResponse["correction"],
  view: ClipView,
  context: ClipContext,
  timeline: Timeline,
): CorrectionResult {
  if (!correction.propose) return { ok: false, reason: "not-proposed" };
  if (original.segments.length !== 1) return { ok: false, reason: "multi-segment-not-supported" };
  const segment = original.segments[0];
  if (!segment) return { ok: false, reason: "no-segment" };

  const startRef = correction.startRef.trim() ? normalizeRef(correction.startRef) : null;
  const endRef = correction.endRef.trim() ? normalizeRef(correction.endRef) : null;
  if (!startRef && !endRef) return { ok: false, reason: "no-edge-given" };

  const startPool = new Map(
    [...view.events, ...context.before].map((e) => [e.ref, e.sourceStartMs] as const),
  );
  const endPool = new Map(
    [...view.events, ...context.after].map((e) => [e.ref, e.sourceEndMs] as const),
  );
  if (startRef && !startPool.has(startRef)) return { ok: false, reason: "unknown-start-ref" };
  if (endRef && !endPool.has(endRef)) return { ok: false, reason: "unknown-end-ref" };

  const startMs = startRef ? (startPool.get(startRef) as number) : segment.startMs;
  const endMs = endRef ? (endPool.get(endRef) as number) : segment.endMs;
  if (endMs <= startMs) return { ok: false, reason: "reversed" };
  if (startMs === segment.startMs && endMs === segment.endMs)
    return { ok: false, reason: "unchanged" };
  const length = endMs - startMs;
  if (length < DURATION_LIMITS.minDurationMs) return { ok: false, reason: "too-short" };
  if (length > DURATION_LIMITS.maxDurationMs) return { ok: false, reason: "too-long" };

  const segments = toSegments(timeline, [{ episode: segment.episode, startMs, endMs }]);
  const key = clipKey(segments);
  const adjustments = [
    ...(startMs !== segment.startMs
      ? [
          {
            segment: 0,
            edge: "start" as const,
            fromMs: segment.startMs,
            toMs: startMs,
            reason: "editorial-correction",
          },
        ]
      : []),
    ...(endMs !== segment.endMs
      ? [
          {
            segment: 0,
            edge: "end" as const,
            fromMs: segment.endMs,
            toMs: endMs,
            reason: "editorial-correction",
          },
        ]
      : []),
  ];
  const candidate: Candidate = {
    ...original,
    id: `${original.method}:${key}`,
    clipKey: key,
    rank: original.rank,
    score: null,
    segments,
    durationMs: intervalDurationMs(segments),
    adjustments: [...original.adjustments, ...adjustments],
    cues: [...new Set([...original.cues, "src:editorial-correction"])],
    derivedFrom: original.id,
  };
  const errors = checkCandidate(candidate, timeline).filter((i) => i.severity === "error");
  if (errors.length) return { ok: false, reason: `invalid:${errors.map((e) => e.code).join(",")}` };
  return { ok: true, candidate, startRef, endRef };
}
