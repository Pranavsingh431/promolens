import type { Candidate, CandidateSet } from "../evaluation/candidate.ts";

/**
 * The pool Phase 4 ranks. The Phase 3 hybrid set holds every AI candidate and
 * every cue candidate, merged where they are the same moment, but uniform
 * windows only where they merged with one of those. Uniform windows that
 * cover story time no hybrid clip covers are added back as a story-blind
 * check on what discovery missed. Nothing else is added or removed.
 */

export const POOL_CONFIG = { version: "pool-1", maxCoveredShare: 0.5 } as const;

function coveredShare(window: Candidate, clips: readonly Candidate[]): number {
  let best = 0;
  for (const segment of window.segments) {
    const length = segment.endMs - segment.startMs;
    for (const clip of clips) {
      for (const other of clip.segments) {
        if (other.episode !== segment.episode) continue;
        const overlap =
          Math.min(segment.endMs, other.endMs) - Math.max(segment.startMs, other.startMs);
        if (overlap > 0) best = Math.max(best, overlap / length);
      }
    }
  }
  return best;
}

export type RankingPool = {
  candidates: Candidate[];
  stats: {
    hybrid: number;
    uniformAvailable: number;
    uniformAdded: number;
    bySource: Record<string, number>;
  };
};

export function buildRankingPool(
  hybrid: CandidateSet,
  uniform: CandidateSet | null,
  config: { maxCoveredShare: number } = POOL_CONFIG,
): RankingPool {
  const byEpisode = new Map<number, Candidate[]>();
  for (const c of hybrid.candidates) {
    const episode = c.segments[0]?.episode ?? 0;
    byEpisode.set(episode, [...(byEpisode.get(episode) ?? []), c]);
  }
  const keys = new Set(hybrid.candidates.map((c) => c.clipKey));
  const gaps = (uniform?.candidates ?? []).filter(
    (w) =>
      !keys.has(w.clipKey) &&
      coveredShare(w, byEpisode.get(w.segments[0]?.episode ?? 0) ?? []) < config.maxCoveredShare,
  );
  const candidates = [
    ...hybrid.candidates,
    ...gaps.map((w) => ({
      ...w,
      cues: [...new Set(["src:uniform", "pool:coverage-gap", ...w.cues])],
    })),
  ];
  const bySource: Record<string, number> = {};
  for (const c of candidates) {
    for (const cue of c.cues) if (cue.startsWith("src:")) bySource[cue] = (bySource[cue] ?? 0) + 1;
  }
  return {
    candidates,
    stats: {
      hybrid: hybrid.candidates.length,
      uniformAvailable: uniform?.candidates.length ?? 0,
      uniformAdded: gaps.length,
      bySource,
    },
  };
}
