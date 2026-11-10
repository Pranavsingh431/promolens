import { intervalIoU, type Interval } from "../evaluation/candidate.ts";
import type { RankingConfig } from "./config.ts";
import { narrativeSimilarity, type NarrativeVectors } from "./narrative.ts";
import { TIER_ORDER, type Tier } from "./scoring.ts";

/**
 * Stage F: a shortlist that does not repeat the same moment.
 *
 * Similarity between two clips is the largest of:
 * - time: overlap of their intervals (IoU);
 * - events: overlap of their story events (Jaccard, camera directions ignored);
 * - pattern: the same hook kind (0.2), the same kind of unresolved tension
 *   (0.1), and shared speakers (up to 0.1). Pattern similarity is capped at
 *   0.4, below the redundancy line, so two different scenes with the same
 *   characters are never treated as the same moment, only as less novel.
 *
 * Time and events cannot see a story beat retold in another episode, so
 * selection also compares narrative text (see narrative.ts). Clips at or
 * above `narrativeRepeat` are the same beat and do not need to overlap.
 *
 * Selection walks the ranked list. A clip that repeats a picked clip, by any
 * of those measures, becomes an alternate of it. Otherwise, among the next
 * `lookahead` clips, it picks the one with the highest
 * lambda x rank utility - (1 - lambda) x similarity to the picks. Rank
 * utility falls linearly over the first 3 x top places, so a clip can move up
 * only a few places for novelty, and never past a better-ranked clip of a
 * higher quality tier.
 */

export type DiversityItem = {
  id: string;
  segments: readonly Interval[];
  storyEvents: ReadonlySet<string>;
  speakers: ReadonlySet<string>;
  hookKind: string | null;
  tension: string | null;
  tier: Tier;
  /** Absent when narrative comparison does not apply, as when choosing finalists. */
  narrative?: NarrativeVectors;
};

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

export type Similarity = {
  value: number;
  basis: "time" | "events" | "pattern" | "narrative" | "none";
};

export function similarity(a: DiversityItem, b: DiversityItem): Similarity {
  const time = intervalIoU(a.segments, b.segments);
  const events = jaccard(a.storyEvents, b.storyEvents);
  const pattern = Math.min(
    0.4,
    (a.hookKind && a.hookKind === b.hookKind ? 0.2 : 0) +
      (a.tension && a.tension === b.tension && a.tension !== "none" ? 0.1 : 0) +
      0.1 * jaccard(a.speakers, b.speakers),
  );
  const best = Math.max(time, events, pattern);
  if (best === 0) return { value: 0, basis: "none" };
  return { value: best, basis: best === time ? "time" : best === events ? "events" : "pattern" };
}

export type DiversityResult = {
  selected: Array<{
    id: string;
    listPosition: number;
    maxSimilarity: number;
    nearest: string | null;
  }>;
  alternates: Array<{
    id: string;
    listPosition: number;
    redundantWith: string;
    similarity: Similarity;
  }>;
  /** Clips that were passed over at least once for a more novel one. Kept for inspection. */
  deferred: string[];
};

export function selectDiverse(
  ranked: readonly DiversityItem[],
  config: RankingConfig["diversity"],
): DiversityResult {
  const horizon = Math.max(1, config.top * 3);
  const utility = (position: number) => Math.max(0, 1 - position / horizon);
  const position = new Map(ranked.map((item, i) => [item.id, i]));
  const remaining = [...ranked];
  const selected: DiversityResult["selected"] = [];
  const picked: DiversityItem[] = [];
  const alternates: DiversityResult["alternates"] = [];
  const deferred = new Set<string>();

  // A repeat beats any plain resemblance when deciding which pick a clip is closest to.
  const closest = (item: DiversityItem) => {
    let best: { id: string; sim: Similarity; repeat: boolean } | null = null;
    for (const p of picked) {
      const story =
        item.narrative && p.narrative ? narrativeSimilarity(item.narrative, p.narrative) : 0;
      const overlap = similarity(item, p);
      const sameBeat = story >= config.narrativeRepeat && story > 0;
      const sim: Similarity = sameBeat ? { value: story, basis: "narrative" } : overlap;
      const repeat = sameBeat || overlap.value >= config.redundancy;
      if (
        !best ||
        (repeat && !best.repeat) ||
        (repeat === best.repeat && sim.value > best.sim.value)
      ) {
        best = { id: p.id, sim, repeat };
      }
    }
    return best;
  };

  while (selected.length < config.top && remaining.length > 0) {
    // Move clips that repeat a pick to the alternates.
    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i] as DiversityItem;
      const near = closest(item);
      if (near?.repeat) {
        alternates.push({
          id: item.id,
          listPosition: (position.get(item.id) ?? 0) + 1,
          redundantWith: near.id,
          similarity: near.sim,
        });
        remaining.splice(i, 1);
        i--;
      }
    }
    if (remaining.length === 0) break;

    const lead = remaining[0] as DiversityItem;
    const window = remaining
      .slice(0, Math.max(1, config.lookahead))
      .filter((r) => TIER_ORDER[r.tier] >= TIER_ORDER[lead.tier]);
    let choice = window[0] as DiversityItem;
    let choiceValue = Number.NEGATIVE_INFINITY;
    for (const item of window) {
      const sim = closest(item)?.sim.value ?? 0;
      const value = config.lambda * utility(position.get(item.id) ?? 0) - (1 - config.lambda) * sim;
      if (value > choiceValue + 1e-12) {
        choice = item;
        choiceValue = value;
      }
    }
    for (const item of window) {
      if ((position.get(item.id) ?? 0) < (position.get(choice.id) ?? 0)) deferred.add(item.id);
    }
    const near = closest(choice);
    selected.push({
      id: choice.id,
      listPosition: (position.get(choice.id) ?? 0) + 1,
      maxSimilarity: near?.sim.value ?? 0,
      nearest: near?.id ?? null,
    });
    picked.push(choice);
    remaining.splice(remaining.indexOf(choice), 1);
  }

  return {
    selected,
    alternates,
    deferred: [...deferred].filter((id) => !selected.some((s) => s.id === id)),
  };
}
