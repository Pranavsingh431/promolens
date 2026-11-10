import {
  DURATION_LIMITS,
  clipKey,
  intervalDurationMs,
  type Adjustment,
  type Candidate,
  type Interval,
} from "../evaluation/candidate.ts";
import { fixDialogueSplits, toSegments } from "../evaluation/structural-checks.ts";
import type { Episode, ScreenplayEvent } from "../screenplay/schema.ts";
import type { Timeline } from "../screenplay/timeline.ts";
import { MAX_PROPOSALS, type Proposal, type ProposalResponse } from "./proposal.ts";

/**
 * Turns model proposals into candidates. All timing comes from the canonical
 * events the proposal points at; the model never supplies a timestamp.
 *
 * Boundary rules, applied in order and each recorded as an adjustment:
 * 1. Widen the clip so it contains the hook and cliffhanger events.
 * 2. If the hook starts more than 3 s in, trim the setup before it, unless
 *    the model marked an earlier event as needed. Then keep it and flag it.
 * 3. If more than 2 s of content follows the cliffhanger, trim it, unless the
 *    model marked a later event as needed. Then keep it and flag it.
 * 4. Fix the length only in ways that keep the hook within the first 3 s and
 *    the cliffhanger last: drop setup before the hook, add earlier context
 *    inside the hook window, or add a short tail with no new spoken line.
 * 5. Move edges off a spoken line, and onto a nearby shot change, only when
 *    that keeps rules 1 to 4.
 * If no length in 20 to 60 s keeps the hook and the cliffhanger, the proposal
 * is rejected with a reason rather than bent into a different clip.
 */

export const RESOLVE_CONFIG = {
  version: "resolve-1",
  hookWindowMs: 3_000,
  cliffhangerTailMs: 2_000,
  snapMs: 1_000,
} as const;

export const RESOLVE_REJECT_REASONS = [
  "beyond-proposal-limit",
  "unknown-anchor",
  "reversed-anchors",
  "no-valid-hook-ref",
  "no-valid-cliffhanger-ref",
  "too-short",
  "too-long",
  "duplicate-in-response",
] as const;
export type ResolveRejectReason = (typeof RESOLVE_REJECT_REASONS)[number];

export type ProposalOutcome = {
  index: number;
  status: "accepted" | "rejected";
  reason?: ResolveRejectReason;
  detail?: string;
  /** Event numbers the model used that do not exist in the episode. */
  unknownRefs: number[];
  /** Interval from the model's anchors, before any change. */
  proposed?: Interval;
  final?: Interval;
  adjustments: Adjustment[];
  flags: string[];
  refs?: {
    start: string;
    end: string;
    hook: string[];
    cliffhanger: string[];
    supporting: string[];
  };
  candidateId?: string;
};

type Options = { method: string; methodVersion: string };

export function resolveProposals(
  response: ProposalResponse,
  episode: Episode,
  timeline: Timeline,
  options: Options,
): { outcomes: ProposalOutcome[]; candidates: Candidate[] } {
  const bySeq = new Map(episode.events.map((event) => [event.seq, event]));
  const outcomes: ProposalOutcome[] = [];
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  response.proposals.forEach((proposal, index) => {
    const outcome = resolveOne(proposal, index, episode, timeline, bySeq, options);
    if (outcome.outcome.status === "accepted" && outcome.candidate) {
      if (seen.has(outcome.candidate.clipKey)) {
        outcomes.push({
          ...outcome.outcome,
          status: "rejected",
          reason: "duplicate-in-response",
          detail: "Same interval as an earlier proposal in this response.",
          candidateId: undefined,
        });
        return;
      }
      seen.add(outcome.candidate.clipKey);
      candidates.push(outcome.candidate);
    }
    outcomes.push(outcome.outcome);
  });
  return { outcomes, candidates };
}

function resolveOne(
  proposal: Proposal,
  index: number,
  episode: Episode,
  timeline: Timeline,
  bySeq: Map<number, ScreenplayEvent>,
  options: Options,
): { outcome: ProposalOutcome; candidate?: Candidate } {
  const referenced = [
    proposal.startEvent,
    proposal.endEvent,
    ...proposal.hookEvents,
    ...proposal.cliffhangerEvents,
    ...proposal.supportingEvents,
  ];
  const unknownRefs = [...new Set(referenced.filter((n) => !bySeq.has(n)))].sort((a, b) => a - b);
  const reject = (
    reason: ResolveRejectReason,
    detail: string,
    extra: Partial<ProposalOutcome> = {},
  ) => ({
    outcome: {
      index,
      status: "rejected" as const,
      reason,
      detail,
      unknownRefs,
      adjustments: [],
      flags: [],
      ...extra,
    },
  });

  if (index >= MAX_PROPOSALS)
    return reject("beyond-proposal-limit", `Only the first ${MAX_PROPOSALS} proposals are used.`);

  const startEvent = bySeq.get(proposal.startEvent);
  const endEvent = bySeq.get(proposal.endEvent);
  if (!startEvent || !endEvent)
    return reject("unknown-anchor", "Start or end event does not exist.");

  const known = (numbers: number[]) =>
    [...new Set(numbers)]
      .map((n) => bySeq.get(n))
      .filter((e): e is ScreenplayEvent => e !== undefined);
  const hook = known(proposal.hookEvents);
  const cliffhanger = known(proposal.cliffhangerEvents);
  const supporting = known(proposal.supportingEvents);
  if (hook.length === 0) return reject("no-valid-hook-ref", "No hook event exists.");
  if (cliffhanger.length === 0)
    return reject("no-valid-cliffhanger-ref", "No cliffhanger event exists.");

  const proposed: Interval = {
    episode: episode.number,
    startMs: startEvent.startMs,
    endMs: endEvent.endMs,
  };
  if (proposed.endMs <= proposed.startMs) {
    return reject("reversed-anchors", "End event finishes before the start event begins.", {
      proposed,
    });
  }

  const { hookWindowMs, cliffhangerTailMs, snapMs } = RESOLVE_CONFIG;
  const hookStart = Math.min(...hook.map((e) => e.startMs));
  const cliffEnd = Math.max(...cliffhanger.map((e) => e.endMs));
  const clip = { start: proposed.startMs, end: proposed.endMs };
  const adjustments: Adjustment[] = [];
  const flags: string[] = [];
  const move = (edge: "start" | "end", to: number, reason: string) => {
    const from = edge === "start" ? clip.start : clip.end;
    if (from === to) return;
    adjustments.push({ segment: 0, edge, fromMs: from, toMs: to, reason });
    clip[edge] = to;
  };
  const length = () => clip.end - clip.start;
  const hookKept = () =>
    clip.start <= hookStart &&
    (flags.includes("late-hook") || hookStart - clip.start <= hookWindowMs);
  const endingKept = () =>
    clip.end >= cliffEnd &&
    (flags.includes("content-after-cliffhanger") || clip.end - cliffEnd <= cliffhangerTailMs);
  const cameraEdges = (from: number, to: number, edge: "start" | "end") =>
    timeline
      .boundariesNear(episode.number, (from + to) / 2, (to - from) / 2, { kinds: ["camera"] })
      .filter((b) => b.edge === edge && b.ms >= from && b.ms <= to)
      .map((b) => b.ms);
  const splitsDialogue = (ms: number) =>
    timeline.boundaryContext(episode.number, ms, 0).splits.some((e) => e.kind === "dialogue");

  // 1. Contain the hook and the cliffhanger.
  if (hookStart < clip.start) move("start", hookStart, "start-moved-to-include-hook");
  if (cliffEnd > clip.end) move("end", cliffEnd, "end-moved-to-include-cliffhanger");

  // 2. Late hook.
  if (hookStart - clip.start > hookWindowMs) {
    if (supporting.some((e) => e.startMs < hookStart && e.endMs > clip.start)) {
      flags.push("late-hook");
    } else {
      const shot = cameraEdges(hookStart - hookWindowMs, hookStart, "start").at(-1);
      move("start", shot ?? hookStart, "start-trimmed-to-hook");
    }
  }

  // 3. Content after the cliffhanger.
  if (clip.end - cliffEnd > cliffhangerTailMs) {
    if (supporting.some((e) => e.endMs > cliffEnd && e.startMs < clip.end)) {
      flags.push("content-after-cliffhanger");
    } else {
      move("end", cliffEnd, "end-trimmed-to-cliffhanger");
    }
  }

  // 4a. Too long: drop setup before the hook, never the ending.
  if (length() > DURATION_LIMITS.maxDurationMs) {
    const needed = clip.end - DURATION_LIMITS.maxDurationMs;
    if (needed > hookStart) {
      return reject(
        "too-long",
        `Hook to ending alone runs ${((clip.end - hookStart) / 1000).toFixed(1)} s.`,
        { proposed },
      );
    }
    const cut = episode.events
      .map((e) => e.startMs)
      .filter((ms) => ms >= needed && ms <= hookStart)
      .sort((a, b) => a - b)[0];
    move("start", cut ?? hookStart, "start-trimmed-to-fit-60s");
  }

  // 4b. Too short: earlier context inside the hook window, then a short tail without a new line.
  if (length() < DURATION_LIMITS.minDurationMs) {
    const earliest = Math.max(0, hookStart - hookWindowMs);
    const starts = episode.events
      .map((e) => e.startMs)
      .filter((ms) => ms >= earliest && ms < clip.start)
      .sort((a, b) => b - a);
    const enough = starts.find((ms) => clip.end - ms >= DURATION_LIMITS.minDurationMs);
    const extended = enough ?? starts.at(-1);
    if (extended !== undefined) move("start", extended, "start-extended-for-length");
  }
  if (length() < DURATION_LIMITS.minDurationMs) {
    const latest = Math.min(episode.durationMs, cliffEnd + cliffhangerTailMs);
    const newLine = (to: number) =>
      episode.events.some((e) => e.kind === "dialogue" && e.startMs > clip.end && e.startMs < to);
    const ends = episode.events
      .map((e) => e.endMs)
      .filter((ms) => ms > clip.end && ms <= latest && !newLine(ms))
      .sort((a, b) => a - b);
    const enough = ends.find((ms) => ms - clip.start >= DURATION_LIMITS.minDurationMs);
    const extended = enough ?? ends.at(-1);
    if (extended !== undefined) move("end", extended, "end-extended-for-length");
  }
  if (length() < DURATION_LIMITS.minDurationMs) {
    return reject(
      "too-short",
      `Only ${(length() / 1000).toFixed(1)} s fit around the hook and the ending.`,
      { proposed, adjustments },
    );
  }

  // 5a. Do not cut through a spoken line, if the fix keeps the hook and the ending.
  const fixed = fixDialogueSplits(timeline, [
    { episode: episode.number, startMs: clip.start, endMs: clip.end },
  ]);
  if (fixed.adjustments.length > 0) {
    const before = { ...clip };
    const [interval] = fixed.intervals;
    if (interval) {
      clip.start = interval.startMs;
      clip.end = interval.endMs;
    }
    if (hookKept() && endingKept()) {
      adjustments.push(...fixed.adjustments);
    } else {
      Object.assign(clip, before);
      flags.push("cuts-dialogue");
    }
  }

  // 5b. Prefer a nearby shot change, if it keeps everything else.
  const tryEdge = (edge: "start" | "end", to: number | undefined, reason: string) => {
    if (to === undefined || to === clip[edge]) return;
    const before = clip[edge];
    clip[edge] = to;
    const legal =
      length() >= DURATION_LIMITS.minDurationMs &&
      length() <= DURATION_LIMITS.maxDurationMs &&
      clip.start >= 0 &&
      clip.end <= episode.durationMs &&
      !splitsDialogue(to) &&
      hookKept() &&
      endingKept();
    clip[edge] = before;
    if (legal) move(edge, to, reason);
  };
  tryEdge(
    "start",
    cameraEdges(clip.start - snapMs, clip.start, "start").at(-1),
    "start-snapped-to-shot",
  );
  tryEdge("end", cameraEdges(clip.end, clip.end + snapMs, "end")[0], "end-snapped-to-shot");

  const final: Interval = { episode: episode.number, startMs: clip.start, endMs: clip.end };
  const segments = toSegments(timeline, [final]);
  const key = clipKey(segments);
  const candidate: Candidate = {
    id: `${options.method}:${key}`,
    clipKey: key,
    method: options.method,
    methodVersion: options.methodVersion,
    rank: 1,
    score: null,
    segments,
    durationMs: intervalDurationMs(segments),
    adjustments,
    cues: [
      `hook:${proposal.hookType}`,
      ...proposal.warnings.map((w) => `warn:${w}`),
      ...flags.map((f) => `flag:${f}`),
    ],
  };
  return {
    candidate,
    outcome: {
      index,
      status: "accepted",
      unknownRefs,
      proposed,
      final,
      adjustments,
      flags,
      refs: {
        start: startEvent.id,
        end: endEvent.id,
        hook: hook.map((e) => e.id),
        cliffhanger: cliffhanger.map((e) => e.id),
        supporting: supporting.map((e) => e.id),
      },
      candidateId: candidate.id,
    },
  };
}
