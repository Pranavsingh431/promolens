import type { Timeline } from "../screenplay/timeline.ts";
import {
  DURATION_LIMITS,
  clipKey,
  intervalDurationMs,
  intervalIoU,
  type Adjustment,
  type Candidate,
  type CandidateSegment,
  type CandidateSet,
  type Interval,
} from "./candidate.ts";

/**
 * Deterministic checks every candidate must pass before a human sees it.
 * Errors make a candidate structurally invalid. Warnings mark legal clips with
 * likely boundary problems, such as starting halfway through a spoken line.
 */

export const STRUCTURAL_SEVERITY = {
  "unknown-episode": "error",
  "invalid-segment": "error",
  "duration-out-of-range": "error",
  "duration-mismatch": "error",
  "overlapping-segments": "error",
  "event-refs-mismatch": "error",
  "no-on-screen-content": "error",
  "id-mismatch": "error",
  "duplicate-interval": "error",
  "starts-mid-dialogue": "warning",
  "ends-mid-dialogue": "warning",
  "no-dialogue-or-action": "warning",
  "near-duplicate": "warning",
  "starts-mid-shot": "info",
  "ends-mid-shot": "info",
  "out-of-story-order": "info",
} as const;

export type StructuralCode = keyof typeof STRUCTURAL_SEVERITY;

export type StructuralIssue = {
  code: StructuralCode;
  severity: (typeof STRUCTURAL_SEVERITY)[StructuralCode];
  message: string;
  segment?: number;
  eventIds?: string[];
};

function issue(
  code: StructuralCode,
  message: string,
  extra: Pick<StructuralIssue, "segment" | "eventIds"> = {},
): StructuralIssue {
  return { code, severity: STRUCTURAL_SEVERITY[code], message, ...extra };
}

/** Attaches the ids of every overlapping event to each interval. */
export function toSegments(timeline: Timeline, intervals: readonly Interval[]): CandidateSegment[] {
  return intervals.map((interval) => ({
    ...interval,
    eventIds: timeline
      .eventsInRange(interval.episode, interval.startMs, interval.endMs)
      .map((event) => event.id),
  }));
}

export function checkCandidate(candidate: Candidate, timeline: Timeline): StructuralIssue[] {
  const issues: StructuralIssue[] = [];

  candidate.segments.forEach((segment, index) => {
    const check = timeline.checkSegment(segment);
    if (!check.ok) {
      for (const problem of check.problems) {
        issues.push(
          problem === "unknown-episode"
            ? issue("unknown-episode", `Episode ${segment.episode} is not in this show.`, {
                segment: index,
              })
            : issue("invalid-segment", `Segment ${index + 1} is ${problem}.`, { segment: index }),
        );
      }
      return;
    }

    const events = timeline.eventsInRange(segment.episode, segment.startMs, segment.endMs);
    if (events.map((e) => e.id).join() !== segment.eventIds.join()) {
      issues.push(
        issue(
          "event-refs-mismatch",
          `Segment ${index + 1} lists events that do not match its times.`,
          {
            segment: index,
          },
        ),
      );
    }
    if (events.length === 0) {
      issues.push(
        issue("no-on-screen-content", `Segment ${index + 1} has no events.`, { segment: index }),
      );
    } else if (!events.some((e) => e.kind === "dialogue" || e.kind === "action")) {
      issues.push(
        issue("no-dialogue-or-action", `Segment ${index + 1} has no dialogue or action.`, {
          segment: index,
        }),
      );
    }

    const edges = [
      ["start", check.splitAtStart],
      ["end", check.splitAtEnd],
    ] as const;
    for (const [edge, split] of edges) {
      const dialogue = split.filter((e) => e.kind === "dialogue").map((e) => e.id);
      if (dialogue.length > 0) {
        issues.push(
          issue(
            edge === "start" ? "starts-mid-dialogue" : "ends-mid-dialogue",
            `Segment ${index + 1} ${edge === "start" ? "starts" : "ends"} in the middle of a spoken line.`,
            { segment: index, eventIds: dialogue },
          ),
        );
      }
      const shots = split.filter((e) => e.kind === "camera").map((e) => e.id);
      if (shots.length > 0) {
        issues.push(
          issue(
            edge === "start" ? "starts-mid-shot" : "ends-mid-shot",
            `Segment ${index + 1} ${edge === "start" ? "starts" : "ends"} in the middle of a camera shot.`,
            { segment: index, eventIds: shots },
          ),
        );
      }
    }
  });

  const total = intervalDurationMs(candidate.segments);
  if (total !== candidate.durationMs) {
    issues.push(
      issue(
        "duration-mismatch",
        `Duration says ${candidate.durationMs} ms but segments add up to ${total} ms.`,
      ),
    );
  }
  if (total < DURATION_LIMITS.minDurationMs || total > DURATION_LIMITS.maxDurationMs) {
    issues.push(
      issue("duration-out-of-range", `Clip runs ${total} ms; it must run 20,000 to 60,000 ms.`),
    );
  }

  candidate.segments.forEach((a, i) => {
    candidate.segments.slice(i + 1).forEach((b, offset) => {
      if (a.episode !== b.episode) return;
      if (a.startMs < b.endMs && b.startMs < a.endMs) {
        issues.push(
          issue(
            "overlapping-segments",
            `Segments ${i + 1} and ${i + offset + 2} reuse the same footage.`,
            {
              segment: i + offset + 1,
            },
          ),
        );
      } else if (b.startMs < a.startMs) {
        issues.push(
          issue(
            "out-of-story-order",
            `Segment ${i + offset + 2} plays before story time it follows.`,
            {
              segment: i + offset + 1,
            },
          ),
        );
      }
    });
  });

  const key = clipKey(candidate.segments);
  if (candidate.clipKey !== key || candidate.id !== `${candidate.method}:${key}`) {
    issues.push(issue("id-mismatch", "Candidate id or clip key does not match its segments."));
  }
  return issues;
}

export type SetCheck = {
  byCandidate: Map<string, StructuralIssue[]>;
  counts: Partial<Record<StructuralCode, number>>;
  valid: number;
  withWarnings: number;
};

/**
 * Checks every candidate, then compares candidates within the set. A later
 * (lower-ranked) candidate with the same interval as an earlier one is an
 * error; one that overlaps an earlier one by at least `nearDuplicateIoU` is a
 * warning. Candidates are swept in start order, so only real neighbours are
 * compared.
 */
export function checkCandidateSet(
  set: Pick<CandidateSet, "candidates">,
  timeline: Timeline,
  options: { nearDuplicateIoU?: number } = {},
): SetCheck {
  const threshold = options.nearDuplicateIoU ?? 0.8;
  const byCandidate = new Map<string, StructuralIssue[]>();
  for (const candidate of set.candidates)
    byCandidate.set(candidate.id, checkCandidate(candidate, timeline));

  const sorted = [...set.candidates].sort(
    (a, b) =>
      (a.segments[0]?.episode ?? 0) - (b.segments[0]?.episode ?? 0) ||
      (a.segments[0]?.startMs ?? 0) - (b.segments[0]?.startMs ?? 0),
  );
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const firstA = a?.segments[0];
    if (!a || !firstA) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const firstB = b?.segments[0];
      if (!b || !firstB) continue;
      if (firstB.episode !== firstA.episode || firstB.startMs >= lastEnd(a)) break;
      const [earlier, later] = a.rank <= b.rank ? [a, b] : [b, a];
      const issues = byCandidate.get(later.id) ?? [];
      if (later.clipKey === earlier.clipKey) {
        issues.push(issue("duplicate-interval", `Same interval as rank ${earlier.rank}.`));
      } else if (intervalIoU(later.segments, earlier.segments) >= threshold) {
        issues.push(issue("near-duplicate", `Overlaps rank ${earlier.rank} almost completely.`));
      }
    }
  }

  const counts: Partial<Record<StructuralCode, number>> = {};
  let valid = 0;
  let withWarnings = 0;
  for (const issues of byCandidate.values()) {
    for (const item of issues) counts[item.code] = (counts[item.code] ?? 0) + 1;
    if (!issues.some((i) => i.severity === "error")) valid += 1;
    if (issues.some((i) => i.severity === "warning")) withWarnings += 1;
  }
  return { byCandidate, counts, valid, withWarnings };
}

function lastEnd(candidate: Candidate): number {
  return Math.max(...candidate.segments.map((s) => s.endMs));
}

/**
 * Moves edges that cut through a spoken line to the edge of that line:
 * outward when the clip stays under 60 s, otherwise inward when it stays over
 * 20 s. Every move is recorded. Returns the new intervals and the moves.
 */
export function fixDialogueSplits(
  timeline: Timeline,
  intervals: readonly Interval[],
): { intervals: Interval[]; adjustments: Adjustment[] } {
  const fixed = intervals.map((s) => ({ ...s }));
  const adjustments: Adjustment[] = [];

  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    fixed.forEach((segment, index) => {
      const episodeEnd = timeline.episode(segment.episode)?.durationMs ?? 0;
      for (const edge of ["start", "end"] as const) {
        const key = edge === "start" ? "startMs" : "endMs";
        const at = segment[key];
        const split = timeline
          .boundaryContext(segment.episode, at, 0)
          .splits.filter((e) => e.kind === "dialogue");
        if (split.length === 0) continue;

        const starts = split.map((e) => e.startMs);
        const ends = split.map((e) => e.endMs);
        const options =
          edge === "start"
            ? ([
                [Math.min(...starts), "start-extended-to-whole-line"],
                [Math.max(...ends), "start-trimmed-to-whole-line"],
              ] as const)
            : ([
                [Math.max(...ends), "end-extended-to-whole-line"],
                [Math.min(...starts), "end-trimmed-to-whole-line"],
              ] as const);

        for (const [target, reason] of options) {
          segment[key] = target;
          const total = intervalDurationMs(fixed);
          const legal =
            segment.endMs > segment.startMs &&
            segment.startMs >= 0 &&
            segment.endMs <= episodeEnd &&
            total >= DURATION_LIMITS.minDurationMs &&
            total <= DURATION_LIMITS.maxDurationMs;
          if (legal) {
            adjustments.push({ segment: index, edge, fromMs: at, toMs: target, reason });
            moved = true;
            break;
          }
          segment[key] = at;
        }
      }
    });
    if (!moved) break;
  }
  return { intervals: fixed, adjustments };
}

/**
 * A corrected copy of a candidate whose edges split dialogue. The original is
 * left untouched; the copy has a new id, `derivedFrom`, and the moves made.
 * Returns null when nothing needed fixing or no legal fix exists.
 */
export function proposeBoundaryFix(candidate: Candidate, timeline: Timeline): Candidate | null {
  const { intervals, adjustments } = fixDialogueSplits(timeline, candidate.segments);
  if (adjustments.length === 0) return null;
  const segments = toSegments(timeline, intervals);
  const key = clipKey(segments);
  return {
    ...candidate,
    id: `${candidate.method}:${key}`,
    clipKey: key,
    segments,
    durationMs: intervalDurationMs(segments),
    adjustments: [...candidate.adjustments, ...adjustments],
    derivedFrom: candidate.id,
  };
}
