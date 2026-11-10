import {
  clipKey,
  intervalDurationMs,
  intervalIoU,
  type Candidate,
  type CandidateSet,
} from "../evaluation/candidate.ts";
import type { Timeline } from "../screenplay/timeline.ts";

/**
 * Combines candidate pools without losing where each clip came from.
 *
 * Two candidates are the same moment only when they overlap heavily in time
 * (IoU >= 0.7) and share most of their story events (Jaccard >= 0.6 over
 * dialogue, action, and sound events; camera directions are ignored). Two
 * clips that overlap but tell different moments stay separate.
 */

export const MERGE_CONFIG = { version: "merge-1", timeIoU: 0.7, eventJaccard: 0.6 } as const;

export type ClipGroup = {
  groupId: string;
  episode: number;
  members: Candidate[];
  methods: string[];
  representative: Candidate;
};

function storyEvents(candidate: Candidate, timeline: Timeline): Set<string> {
  const ids = new Set<string>();
  for (const segment of candidate.segments) {
    for (const id of segment.eventIds) {
      const kind = timeline.event(id)?.kind;
      if (kind && kind !== "camera") ids.add(id);
    }
  }
  return ids;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const id of a) if (b.has(id)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Lower number wins when choosing the clip that stands for a group. */
function sourcePriority(method: string): number {
  if (method.startsWith("ai-")) return 0;
  if (method === "cues") return 1;
  return 2;
}

function byPreference(a: Candidate, b: Candidate): number {
  return (
    sourcePriority(a.method) - sourcePriority(b.method) ||
    (a.method < b.method ? -1 : a.method > b.method ? 1 : 0) ||
    a.rank - b.rank
  );
}

/** Groups duplicates across all given candidates. Sweeps by start time per episode. */
export function groupDuplicates(
  candidates: readonly Candidate[],
  timeline: Timeline,
  config: { timeIoU: number; eventJaccard: number } = MERGE_CONFIG,
): ClipGroup[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)].sort();
    if (ra && rb && ra !== rb) parent.set(rb, ra);
  };

  const sorted = [...candidates].sort(
    (a, b) =>
      (a.segments[0]?.episode ?? 0) - (b.segments[0]?.episode ?? 0) ||
      (a.segments[0]?.startMs ?? 0) - (b.segments[0]?.startMs ?? 0) ||
      (a.id < b.id ? -1 : 1),
  );
  const events = new Map(sorted.map((c) => [c.id, storyEvents(c, timeline)]));
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (!a) continue;
    const aEnd = Math.max(...a.segments.map((s) => s.endMs));
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (!b) continue;
      if (
        b.segments[0]?.episode !== a.segments[0]?.episode ||
        (b.segments[0]?.startMs ?? 0) >= aEnd
      )
        break;
      if (
        intervalIoU(a.segments, b.segments) >= config.timeIoU &&
        jaccard(events.get(a.id) ?? new Set(), events.get(b.id) ?? new Set()) >= config.eventJaccard
      ) {
        union(a.id, b.id);
      }
    }
  }

  const groups = new Map<string, Candidate[]>();
  for (const candidate of sorted) {
    const root = find(candidate.id);
    groups.set(root, [...(groups.get(root) ?? []), candidate]);
  }
  return [...groups.values()]
    .map((members) => {
      const ordered = [...members].sort(byPreference);
      const representative = ordered[0] as Candidate;
      return {
        groupId: `G:${representative.clipKey}`,
        episode: representative.segments[0]?.episode ?? 0,
        members: ordered,
        methods: [...new Set(ordered.map((m) => m.method))].sort(),
        representative,
      };
    })
    .sort((a, b) => a.episode - b.episode || (a.groupId < b.groupId ? -1 : 1));
}

export type HybridStats = {
  groups: number;
  aiOnly: number;
  baselineOnly: number;
  shared: number;
  uniformFallbackEpisodes: number[];
};

/**
 * The combined pool for later ranking: every group with an AI or cue
 * candidate, plus uniform windows only for episodes where nothing else
 * exists. Order is provisional: AI groups in AI order, then cue groups, then
 * fallback windows, episode by episode. Phase 4 replaces this ordering.
 */
export function buildHybridSet(
  sets: readonly CandidateSet[],
  timeline: Timeline,
  packSha256: string,
): { set: CandidateSet; groups: ClipGroup[]; stats: HybridStats } {
  const all = sets.flatMap((s) => s.candidates);
  const groups = groupDuplicates(all, timeline);
  const isAi = (g: ClipGroup) => g.methods.some((m) => m.startsWith("ai-"));
  const isCue = (g: ClipGroup) => g.methods.includes("cues");
  const covered = new Set(groups.filter((g) => isAi(g) || isCue(g)).map((g) => g.episode));
  const fallback = [
    ...new Set(groups.filter((g) => !covered.has(g.episode)).map((g) => g.episode)),
  ].sort((a, b) => a - b);

  const tier = (g: ClipGroup) => (isAi(g) ? 0 : isCue(g) ? 1 : 2);
  const bestRank = (g: ClipGroup) =>
    Math.min(...g.members.filter((m) => sourcePriority(m.method) === tier(g)).map((m) => m.rank));
  const chosen = groups
    .filter((g) => isAi(g) || isCue(g) || fallback.includes(g.episode))
    .sort((a, b) => a.episode - b.episode || tier(a) - tier(b) || bestRank(a) - bestRank(b));

  const candidates: Candidate[] = chosen.map((group, index) => {
    const source = group.representative;
    const key = clipKey(source.segments);
    return {
      ...source,
      id: `hybrid:${key}`,
      clipKey: key,
      method: "hybrid",
      methodVersion: `${MERGE_CONFIG.version}(${[...new Set(sets.map((s) => `${s.method}@${s.methodVersion}`))].sort().join(",")})`,
      rank: index + 1,
      score: null,
      durationMs: intervalDurationMs(source.segments),
      cues: [...group.methods.map((m) => `src:${m.replace(/[^a-z0-9-]/g, "-")}`), ...source.cues],
      derivedFrom: source.id,
    };
  });

  return {
    set: {
      method: "hybrid",
      methodVersion: candidates[0]?.methodVersion ?? MERGE_CONFIG.version,
      packSha256,
      candidates,
      rejected: {},
      proposals: candidates.length,
    },
    groups,
    stats: {
      groups: groups.length,
      aiOnly: groups.filter((g) => isAi(g) && g.methods.every((m) => m.startsWith("ai-"))).length,
      baselineOnly: groups.filter((g) => !isAi(g)).length,
      shared: groups.filter((g) => isAi(g) && g.methods.some((m) => !m.startsWith("ai-"))).length,
      uniformFallbackEpisodes: fallback,
    },
  };
}
