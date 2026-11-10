import { z } from "zod";

import type { Timeline } from "../screenplay/timeline.ts";
import { clipKey, type CandidateSet, type Interval } from "./candidate.ts";
import { createRandom, shuffle } from "./random.ts";

/**
 * What reviewers see, and how blind review items are prepared.
 *
 * Part A (source-aware): the whole episode's on-screen events, so a reviewer
 * can find promo moments before seeing any method's suggestions.
 *
 * Part B (cold viewer): one clip at a time, showing only the events inside
 * it, with times counted from the clip start. No episode number, no scene
 * headings, no event ids, no writer notes, no method, no score.
 */

const intervalSchema = z.object({
  episode: z.number().int().positive(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
});

export const reviewItemsSchema = z.object({
  sampleVersion: z.string(),
  seed: z.number().int(),
  items: z.array(
    z.object({
      itemId: z.string().regex(/^B\d{3,}$/),
      clipKey: z.string(),
      segments: z.array(intervalSchema).min(1),
    }),
  ),
});

/** Maps blind items back to candidates. Never shown to reviewers. */
export const reviewKeySchema = z.object({
  entries: z.array(
    z.object({
      itemId: z.string(),
      clipKey: z.string(),
      candidates: z.array(
        z.object({
          id: z.string(),
          method: z.string(),
          methodVersion: z.string(),
          rank: z.number().int(),
          /**
           * "control": a lower-ranked clip added on purpose, so the review is not only of top
           * picks. "shortlist": a final recommendation. "shortlist-control": a lower-ranked clip
           * from the same episode as a recommendation, to compare against it.
           */
          role: z.enum(["top", "control", "shortlist", "shortlist-control"]).optional(),
        }),
      ),
    }),
  ),
});

export type ReviewItems = z.infer<typeof reviewItemsSchema>;
export type ReviewKey = z.infer<typeof reviewKeySchema>;

export function partAView(timeline: Timeline, episodeNumber: number) {
  const episode = timeline.episode(episodeNumber);
  if (!episode) throw new RangeError(`Episode ${episodeNumber} is not in this show`);
  return {
    episode: episode.number,
    durationMs: episode.durationMs,
    scenes: episode.scenes.map((s) => ({
      id: s.id,
      heading: s.heading,
      startMs: s.startMs,
      endMs: s.endMs,
    })),
    events: timeline.chronological(episode.number).map((e) => ({
      id: e.id,
      sceneId: e.sceneId,
      kind: e.kind,
      startMs: e.startMs,
      endMs: e.endMs,
      text: e.text,
      ...(e.speaker ? { speaker: e.speaker, delivery: e.delivery } : {}),
    })),
  };
}

export function coldViewerView(timeline: Timeline, segments: readonly Interval[]) {
  let offsetMs = 0;
  const parts = segments.map((segment) => {
    const events = timeline
      .eventsInRange(segment.episode, segment.startMs, segment.endMs)
      .map((e) => ({
        startMs: offsetMs + Math.max(e.startMs, segment.startMs) - segment.startMs,
        endMs: offsetMs + Math.min(e.endMs, segment.endMs) - segment.startMs,
        kind: e.kind,
        text: e.text,
        ...(e.speaker ? { speaker: e.speaker, delivery: e.delivery } : {}),
        cutAtStart: e.startMs < segment.startMs,
        cutAtEnd: e.endMs > segment.endMs,
      }));
    const part = { offsetMs, durationMs: segment.endMs - segment.startMs, events };
    offsetMs += part.durationMs;
    return part;
  });
  return { durationMs: offsetMs, parts };
}

/**
 * Takes each method's top candidates for the sampled episodes, merges
 * identical intervals into one item, and shuffles the items with a fixed seed.
 *
 * Options:
 * - controls: also add, per episode, a seeded sample of lower-ranked clips
 *   from one set (normally the Phase 4 ranking), so reviewers rate weak and
 *   uncertain clips too and nobody can infer quality from being shown a clip.
 * - shortlist: also add the final recommendations by clip key, and seeded
 *   lower-ranked clips from their episodes to compare them against. A
 *   recommendation often comes from outside the sampled episodes, and these
 *   items are the only direct human check on the list an editor would read.
 * - existing: keep every existing item and id unchanged and append only new
 *   clips, so ratings already made stay valid. New items are shuffled among
 *   themselves.
 */
export function prepareBlindReview(
  sets: readonly Pick<CandidateSet, "candidates">[],
  episodes: readonly number[],
  options: {
    perMethodPerEpisode: number;
    seed: number;
    sampleVersion: string;
    controls?: { method: string; perEpisode: number };
    shortlist?: { method: string; clipKeys: readonly string[]; controlsPerEpisode: number };
    existing?: { items: ReviewItems; key: ReviewKey };
  },
): { items: ReviewItems; key: ReviewKey } {
  const inSample = new Set(episodes);
  const byClip = new Map<string, ReviewKey["entries"][number]>();
  const segmentsByClip = new Map<string, Interval[]>();
  type Role = NonNullable<ReviewKey["entries"][number]["candidates"][number]["role"]>;
  const add = (candidate: CandidateSet["candidates"][number], role: Role) => {
    const key = clipKey(candidate.segments);
    const entry = byClip.get(key) ?? { itemId: "", clipKey: key, candidates: [] };
    if (!entry.candidates.some((c) => c.id === candidate.id)) {
      entry.candidates.push({
        id: candidate.id,
        method: candidate.method,
        methodVersion: candidate.methodVersion,
        rank: candidate.rank,
        role,
      });
    }
    byClip.set(key, entry);
    segmentsByClip.set(
      key,
      candidate.segments.map(({ episode: e, startMs, endMs }) => ({ episode: e, startMs, endMs })),
    );
  };

  for (const set of sets) {
    const taken = new Map<number, number>();
    const ranked = [...set.candidates].sort((a, b) => a.rank - b.rank);
    for (const candidate of ranked) {
      const episode = candidate.segments[0]?.episode ?? 0;
      if (!candidate.segments.every((s) => inSample.has(s.episode))) continue;
      if ((taken.get(episode) ?? 0) >= options.perMethodPerEpisode) continue;
      taken.set(episode, (taken.get(episode) ?? 0) + 1);
      add(candidate, "top");
    }
  }

  if (options.controls) {
    const source = sets.find((set) => set.candidates[0]?.method === options.controls?.method);
    for (const episode of [...inSample].sort((a, b) => a - b)) {
      const inEpisode = (source?.candidates ?? [])
        .filter((c) => c.segments.every((s) => s.episode === episode))
        .sort((a, b) => a.rank - b.rank)
        .slice(options.perMethodPerEpisode)
        .filter((c) => !byClip.has(clipKey(c.segments)));
      const sample = shuffle(
        inEpisode.map((c) => c.id).sort(),
        createRandom(options.seed + episode),
      ).slice(0, options.controls.perEpisode);
      for (const candidate of inEpisode.filter((c) => sample.includes(c.id)))
        add(candidate, "control");
    }
  }

  if (options.shortlist) {
    const { method, clipKeys, controlsPerEpisode } = options.shortlist;
    const wanted = new Set(clipKeys);
    const pool = sets.find((set) => set.candidates[0]?.method === method)?.candidates ?? [];
    const picks = pool.filter((c) => wanted.has(clipKey(c.segments)));
    for (const pick of picks) add(pick, "shortlist");
    const bestRank = new Map<number, number>();
    for (const pick of picks) {
      for (const s of pick.segments) {
        bestRank.set(s.episode, Math.min(bestRank.get(s.episode) ?? pick.rank, pick.rank));
      }
    }
    for (const [episode, rank] of [...bestRank].sort((a, b) => a[0] - b[0])) {
      const lower = pool.filter(
        (c) =>
          c.rank > rank &&
          c.segments.every((s) => s.episode === episode) &&
          !byClip.has(clipKey(c.segments)),
      );
      const chosen = shuffle(lower.map((c) => c.id).sort(), createRandom(options.seed + episode));
      for (const candidate of lower.filter((c) =>
        chosen.slice(0, controlsPerEpisode).includes(c.id),
      )) {
        add(candidate, "shortlist-control");
      }
    }
  }

  const existingItems = options.existing?.items.items ?? [];
  const existingEntries = new Map(options.existing?.key.entries.map((e) => [e.itemId, e]) ?? []);
  const known = new Set(existingItems.map((item) => item.clipKey));
  const order = shuffle(
    [...byClip.keys()].filter((key) => !known.has(key)).sort(),
    createRandom(options.seed),
  );
  const total = existingItems.length + order.length;
  const width = Math.max(
    3,
    String(total).length,
    ...existingItems.map((item) => item.itemId.length - 1),
  );
  const items: ReviewItems["items"] = [...existingItems];
  const entries: ReviewKey["entries"] = existingItems.map((item) => {
    const before = existingEntries.get(item.itemId) ?? {
      itemId: item.itemId,
      clipKey: item.clipKey,
      candidates: [],
    };
    const added = byClip.get(item.clipKey)?.candidates ?? [];
    const ids = new Set(before.candidates.map((c) => c.id));
    return {
      ...before,
      candidates: [...before.candidates, ...added.filter((c) => !ids.has(c.id))],
    };
  });
  order.forEach((key, index) => {
    const itemId = `B${String(existingItems.length + index + 1).padStart(width, "0")}`;
    const entry = byClip.get(key);
    if (!entry) return;
    items.push({ itemId, clipKey: key, segments: segmentsByClip.get(key) ?? [] });
    entries.push({ ...entry, itemId });
  });

  return {
    items: {
      sampleVersion: options.sampleVersion,
      seed: options.existing?.items.seed ?? options.seed,
      items,
    },
    key: { entries },
  };
}

/**
 * Whether a review round shows an item. A round limited to one split hides
 * clips from the other split. Episodes outside the sample belong to neither
 * split, so their clips stay visible.
 */
export function itemVisible(
  item: { segments: ReadonlyArray<{ episode: number }> },
  sampled: ReadonlySet<number>,
  only: readonly number[] | undefined,
): boolean {
  if (!only) return true;
  return item.segments.every((s) => only.includes(s.episode) || !sampled.has(s.episode));
}
