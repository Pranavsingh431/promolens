import { describe, expect, it } from "vitest";

import { syntheticShow } from "../../../tests/support/synthetic-show";
import { createTimeline } from "../screenplay/timeline";
import { generateCueBased, generateUniform } from "./baselines";
import { coldViewerView, itemVisible, partAView, prepareBlindReview } from "./review";

const show = syntheticShow({ episodes: 6, seed: 21 });
const timeline = createTimeline(show);
const sets = [generateUniform(timeline), generateCueBased(timeline)];

describe("coldViewerView", () => {
  it("shows only the clip, timed from its own start, with nothing that reveals its place in the show", () => {
    const view = coldViewerView(timeline, [{ episode: 3, startMs: 40_000, endMs: 70_000 }]);
    expect(view.durationMs).toBe(30_000);
    const events = view.parts[0]?.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.startMs).toBeGreaterThanOrEqual(0);
      expect(event.endMs).toBeLessThanOrEqual(30_000);
    }
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/E00\d|episode|SYNTHETIC LOGLINE|ROOM|STREET|seq|sceneId/);
  });

  it("marks lines already under way or cut off by the clip edges", () => {
    const anyLine = show.episodes[0]?.events.find(
      (e) => e.kind === "dialogue" && e.endMs - e.startMs > 1_000,
    );
    if (!anyLine) throw new Error("fixture has no dialogue");
    const view = coldViewerView(timeline, [
      { episode: 1, startMs: anyLine.startMs + 500, endMs: anyLine.startMs + 30_500 },
    ]);
    expect(view.parts[0]?.events.some((e) => e.cutAtStart)).toBe(true);
  });

  it("joins several segments one after another", () => {
    const view = coldViewerView(timeline, [
      { episode: 2, startMs: 0, endMs: 10_000 },
      { episode: 4, startMs: 5_000, endMs: 20_000 },
    ]);
    expect(view.parts.map((p) => [p.offsetMs, p.durationMs])).toEqual([
      [0, 10_000],
      [10_000, 15_000],
    ]);
  });
});

describe("partAView", () => {
  it("gives the whole episode in time order without writer notes", () => {
    const view = partAView(timeline, 2);
    const starts = view.events.map((e) => e.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(JSON.stringify(view)).not.toContain("SYNTHETIC LOGLINE");
  });
});

describe("prepareBlindReview", () => {
  const options = { perMethodPerEpisode: 2, seed: 77, sampleVersion: "sample-1" };
  const { items, key } = prepareBlindReview(sets, [2, 5], options);

  it("takes each method's top picks for sampled episodes only", () => {
    const perMethod = new Map<string, number>();
    for (const entry of key.entries) {
      for (const candidate of entry.candidates)
        perMethod.set(candidate.method, (perMethod.get(candidate.method) ?? 0) + 1);
    }
    expect(perMethod.get("uniform")).toBe(4);
    expect(perMethod.get("cues")).toBe(4);
    expect(
      items.items.every((item) => item.segments.every((s) => [2, 5].includes(s.episode))),
    ).toBe(true);
  });

  it("hides the method from the items and keeps it only in the key", () => {
    expect(JSON.stringify(items)).not.toMatch(/uniform|cues|score|rank/);
    expect(key.entries.map((e) => e.itemId)).toEqual(items.items.map((i) => i.itemId));
  });

  it("merges a clip proposed by two methods into one item", () => {
    const duplicate = {
      candidates: [{ ...sets[0]!.candidates[0]!, method: "copy", id: "copy:x", rank: 1 }],
    };
    const episode = sets[0]!.candidates[0]!.segments[0]!.episode;
    const merged = prepareBlindReview([sets[0]!, duplicate], [episode], {
      ...options,
      perMethodPerEpisode: 1,
    });
    expect(merged.items.items).toHaveLength(1);
    expect(merged.key.entries[0]?.candidates.map((c) => c.method).sort()).toEqual([
      "copy",
      "uniform",
    ]);
  });

  it("uses a fixed, seeded order", () => {
    expect(prepareBlindReview(sets, [2, 5], options)).toEqual({ items, key });
    const reseeded = prepareBlindReview(sets, [2, 5], { ...options, seed: 78 });
    expect(reseeded.items.items.map((i) => i.clipKey)).not.toEqual(
      items.items.map((i) => i.clipKey),
    );
    expect([...reseeded.items.items.map((i) => i.clipKey)].sort()).toEqual(
      [...items.items.map((i) => i.clipKey)].sort(),
    );
  });
});

describe("review rounds with controls and appended clips", () => {
  const ranked = {
    candidates: [...(sets[1]?.candidates ?? [])]
      .sort((a, b) => a.rank - b.rank)
      .map((c, i) => ({ ...c, id: `ranked:${c.clipKey}`, method: "ranked", rank: i + 1 })),
  };

  it("adds lower-ranked controls the reviewer cannot tell apart from top picks", () => {
    const { items, key } = prepareBlindReview([ranked], [1, 2, 3], {
      perMethodPerEpisode: 1,
      seed: 9,
      sampleVersion: "s",
      controls: { method: "ranked", perEpisode: 1 },
    });
    const controls = key.entries.filter((e) => e.candidates.every((c) => c.role === "control"));
    expect(controls.length).toBeGreaterThan(0);
    expect(JSON.stringify(items)).not.toMatch(/control|ranked|top/);
    for (const entry of controls) {
      const episode = entry.candidates[0]?.id ? Number(entry.clipKey.slice(1, 4)) : 0;
      const topRank = Math.min(
        ...ranked.candidates.filter((c) => c.segments[0]?.episode === episode).map((c) => c.rank),
      );
      expect(entry.candidates[0]?.rank).toBeGreaterThan(topRank);
    }
  });

  it("keeps every existing item and id when appending", () => {
    const first = prepareBlindReview(sets, [1, 2], {
      perMethodPerEpisode: 1,
      seed: 3,
      sampleVersion: "s",
    });
    const second = prepareBlindReview([...sets, ranked], [1, 2, 3], {
      perMethodPerEpisode: 1,
      seed: 3,
      sampleVersion: "s",
      existing: first,
    });
    expect(second.items.items.slice(0, first.items.items.length)).toEqual(first.items.items);
    expect(second.items.items.length).toBeGreaterThan(first.items.items.length);
    const ids = second.items.items.map((i) => i.itemId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(second.items.items.map((i) => i.clipKey)).size).toBe(ids.length);
  });
});

describe("the final recommendations in a review round", () => {
  const ranked = generateUniform(timeline);
  const ordered = [...ranked.candidates].sort((a, b) => a.rank - b.rank);
  // Episode 6 stands in for an episode outside the sample.
  const pick = ordered.find((c) => c.segments[0]?.episode === 6);
  if (!pick) throw new Error("fixture has no episode 6 clip");
  const prepared = prepareBlindReview([ranked], [1, 2], {
    perMethodPerEpisode: 1,
    seed: 4,
    sampleVersion: "v",
    shortlist: {
      method: ranked.method,
      clipKeys: [pick.clipKey],
      controlsPerEpisode: 2,
    },
  });

  it("adds them from outside the sample, with lower-ranked clips to compare against", () => {
    const entry = prepared.key.entries.find((e) => e.clipKey === pick.clipKey);
    expect(entry?.candidates.map((c) => c.role)).toEqual(["shortlist"]);
    const controls = prepared.key.entries.filter((e) =>
      e.candidates.every((c) => c.role === "shortlist-control"),
    );
    expect(controls).toHaveLength(2);
    for (const control of controls) {
      expect(control.clipKey.startsWith("E006")).toBe(true);
      expect(control.candidates[0]?.rank).toBeGreaterThan(pick.rank);
    }
  });

  it("keeps reviewers blind to the role", () => {
    expect(JSON.stringify(prepared.items)).not.toMatch(/shortlist|control|rank|method/);
  });
});

describe("itemVisible", () => {
  const sampled = new Set([1, 2]);
  const inEpisode = (episode: number) => ({ segments: [{ episode }] });

  it("shows everything when a round is not limited", () => {
    expect(itemVisible(inEpisode(2), sampled, undefined)).toBe(true);
  });

  it("hides clips from the other split", () => {
    expect(itemVisible(inEpisode(2), sampled, [1])).toBe(false);
  });

  it("keeps clips from episodes outside the sample visible", () => {
    expect(itemVisible(inEpisode(9), sampled, [1])).toBe(true);
  });
});
