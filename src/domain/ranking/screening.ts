import type { Candidate } from "../evaluation/candidate.ts";
import { createRandom, shuffle } from "../evaluation/random.ts";
import { checkCandidate, type StructuralIssue } from "../evaluation/structural-checks.ts";
import type { Timeline } from "../screenplay/timeline.ts";
import type { RankingConfig } from "./config.ts";
import { MOMENT_TYPES, type MomentType, type ScreenResponse } from "./prompts/screen-v1.ts";
import { weightedScore } from "./scoring.ts";
import { clipView, lineCuts, type ClipView, type LineCut } from "./windows.ts";

/**
 * Stage A (deterministic) and the selection half of Stage B.
 *
 * Stage A removes only clips that cannot be shown as they are: structural
 * errors, an exact repeat of another clip, or nothing on screen in the
 * opening or the ending. Everything else passes with flags.
 *
 * Stage B orders the passing clips by a cheap first read and picks which
 * ones get the detailed assessment. It keeps every episode's best clip, the
 * best clips of every moment type, and a seeded sample of the rest, so quiet,
 * visual, or unusual moments and thin episodes are not screened out by
 * construction. What it leaves out is listed, not hidden.
 */

export type StageA = {
  candidateId: string;
  pass: boolean;
  /** Why the clip cannot be used. Empty when it passes. */
  reasons: string[];
  /** Problems worth knowing about that do not remove the clip. */
  flags: string[];
  structural: StructuralIssue[];
  cuts: LineCut[];
  view: ClipView;
};

const STORY_KINDS = new Set(["dialogue", "action", "sound"]);

export function screenDeterministic(
  candidates: readonly Candidate[],
  timeline: Timeline,
  config: Pick<RankingConfig, "windows" | "boundaries">,
): StageA[] {
  const seen = new Map<string, string>();
  return candidates.map((candidate) => {
    const structural = checkCandidate(candidate, timeline);
    const reasons = structural.filter((i) => i.severity === "error").map((i) => i.code as string);
    // Info-level notes (such as a cut inside a camera shot) stay in `structural` but are not flags.
    const flags = structural.filter((i) => i.severity === "warning").map((i) => i.code as string);

    const earlier = seen.get(candidate.clipKey);
    if (earlier) reasons.push("duplicate-interval");
    else seen.set(candidate.clipKey, candidate.id);

    const valid = !structural.some(
      (i) => i.code === "unknown-episode" || i.code === "invalid-segment",
    );
    const view = valid
      ? clipView(timeline, candidate.segments, config.windows)
      : { durationMs: 0, events: [], opening: [], ending: [] };
    const cuts = valid ? lineCuts(view, candidate.segments, config.boundaries) : [];

    if (valid) {
      if (view.opening.length === 0) reasons.push("nothing-in-opening");
      else if (!view.opening.some((e) => STORY_KINDS.has(e.kind))) flags.push("quiet-opening");
      if (view.ending.length === 0) reasons.push("nothing-in-ending");
      else if (!view.ending.some((e) => STORY_KINDS.has(e.kind))) flags.push("quiet-ending");
      for (const c of cuts) {
        flags.push(`${c.substantial ? "cuts" : "grazes"}-line-at-${c.edge}`);
      }
    }
    return {
      candidateId: candidate.id,
      pass: reasons.length === 0,
      reasons: [...new Set(reasons)],
      flags: [...new Set(flags)],
      structural,
      cuts,
      view,
    };
  });
}

/** Boundary estimate used only for screening priority: 3 by default, lower for cut lines. */
export function boundaryEstimate(cuts: readonly LineCut[]): number {
  const substantial = cuts.filter((c) => c.substantial).length;
  return substantial >= 2 ? 1 : substantial === 1 ? 2 : 3;
}

/** Screening priority: the weighted rubric on the quick ratings, with the boundary estimate. */
export function screenPriority(
  quick: ScreenResponse,
  cuts: readonly LineCut[],
  weights: RankingConfig["weights"],
): number {
  return weightedScore(
    {
      hook: quick.hook,
      cliffhanger: quick.cliffhanger,
      clarity: quick.clarity,
      emotion: quick.emotion,
      boundaries: boundaryEstimate(cuts),
    },
    weights,
  );
}

export type ScreenEntry = {
  candidateId: string;
  clipKey: string;
  episode: number;
  /** Null when the quick read failed. Such clips are kept, never dropped. */
  priority: number | null;
  momentType: MomentType | null;
};

export type SelectionReason =
  "priority" | "episode-floor" | "type-floor" | "exploration" | "screen-failed";

export type Selection = {
  selected: Array<{ candidateId: string; reason: SelectionReason; priorityRank: number | null }>;
  excluded: Array<{ candidateId: string; priorityRank: number }>;
};

/** Higher priority first; ties by clip key so the order never depends on input order. */
function byPriority(a: ScreenEntry, b: ScreenEntry): number {
  return (
    (b.priority ?? -1) - (a.priority ?? -1) ||
    (a.clipKey < b.clipKey ? -1 : a.clipKey > b.clipKey ? 1 : 0)
  );
}

export function selectForAssessment(
  entries: readonly ScreenEntry[],
  config: RankingConfig["screening"],
): Selection {
  const scored = entries.filter((e) => e.priority !== null).sort(byPriority);
  const rank = new Map(scored.map((e, i) => [e.candidateId, i + 1]));
  const chosen = new Map<string, SelectionReason>();

  for (const entry of entries) {
    if (entry.priority === null) chosen.set(entry.candidateId, "screen-failed");
  }
  for (const entry of scored.slice(0, config.shortlist)) chosen.set(entry.candidateId, "priority");

  if (config.episodeFloor) {
    const episodes = [...new Set(scored.map((e) => e.episode))].sort((a, b) => a - b);
    for (const episode of episodes) {
      const inEpisode = scored.filter((e) => e.episode === episode);
      if (!inEpisode.some((e) => chosen.has(e.candidateId)) && inEpisode[0]) {
        chosen.set(inEpisode[0].candidateId, "episode-floor");
      }
    }
  }

  for (const type of MOMENT_TYPES) {
    const ofType = scored.filter((e) => e.momentType === type);
    let have = ofType.filter((e) => chosen.has(e.candidateId)).length;
    for (const entry of ofType) {
      if (have >= config.perTypeFloor) break;
      if (chosen.has(entry.candidateId)) continue;
      chosen.set(entry.candidateId, "type-floor");
      have += 1;
    }
  }

  const rest = scored.filter((e) => !chosen.has(e.candidateId));
  const sample = shuffle(rest.map((e) => e.candidateId).sort(), createRandom(config.seed)).slice(
    0,
    config.explore,
  );
  for (const id of sample) chosen.set(id, "exploration");

  const order = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  return {
    selected: [...chosen.entries()]
      .map(([candidateId, reason]) => ({
        candidateId,
        reason,
        priorityRank: rank.get(candidateId) ?? null,
      }))
      .sort(
        (a, b) =>
          order(a.candidateId) - order(b.candidateId) || (a.candidateId < b.candidateId ? -1 : 1),
      ),
    excluded: scored
      .filter((e) => !chosen.has(e.candidateId))
      .map((e) => ({ candidateId: e.candidateId, priorityRank: rank.get(e.candidateId) ?? 0 })),
  };
}
