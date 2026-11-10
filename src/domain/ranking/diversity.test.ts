import { describe, expect, it } from "vitest";

import { DEFAULT_RANKING_CONFIG } from "./config";
import { selectDiverse, similarity, type DiversityItem } from "./diversity";
import { narrativeVectors } from "./narrative";

function item(
  id: string,
  startMs: number,
  options: Partial<DiversityItem> & { episode?: number; endMs?: number; events?: string[] } = {},
): DiversityItem {
  const episode = options.episode ?? 1;
  return {
    id,
    segments: [{ episode, startMs, endMs: options.endMs ?? startMs + 30_000 }],
    storyEvents: new Set(options.events ?? [`${id}-1`, `${id}-2`]),
    speakers: options.speakers ?? new Set([id.toUpperCase()]),
    hookKind: options.hookKind ?? null,
    tension: options.tension ?? null,
    tier: options.tier ?? "strong",
    ...(options.narrative ? { narrative: options.narrative } : {}),
  };
}

const CONFIG = { ...DEFAULT_RANKING_CONFIG.diversity, top: 3 };

describe("similarity", () => {
  it("is the largest of time overlap, shared story events, and pattern", () => {
    expect(similarity(item("a", 0), item("b", 15_000)).basis).toBe("time");
    expect(similarity(item("a", 0), item("b", 15_000)).value).toBeCloseTo(1 / 3, 6);
    const shared = similarity(
      item("a", 0, { events: ["x", "y", "z"] }),
      item("b", 40_000, { events: ["x", "y", "z", "w"] }),
    );
    expect(shared).toEqual({ value: 0.75, basis: "events" });
  });

  it("never treats the same characters in a different scene as the same moment", () => {
    const same = {
      hookKind: "confrontation",
      tension: "escalating-confrontation",
      speakers: new Set(["MAYA", "JACK"]),
    };
    const sim = similarity(
      item("a", 0, { ...same, episode: 1 }),
      item("b", 0, { ...same, episode: 7 }),
    );
    expect(sim).toEqual({ value: 0.4, basis: "pattern" });
    expect(sim.value).toBeLessThan(DEFAULT_RANKING_CONFIG.diversity.redundancy);
  });
});

describe("diversity-aware selection", () => {
  it("sets near-identical moments aside as alternates of the stronger clip", () => {
    const ranked = [item("a", 0), item("a2", 3_000), item("b", 60_000), item("c", 120_000)];
    const result = selectDiverse(ranked, CONFIG);
    expect(result.selected.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(result.alternates).toEqual([
      expect.objectContaining({ id: "a2", redundantWith: "a", listPosition: 2 }),
    ]);
  });

  it("may move a more novel clip up a few places, but no further than the lookahead", () => {
    const pattern = { hookKind: "slap", tension: "pending-decision", speakers: new Set(["X"]) };
    const ranked = [
      item("a", 0, pattern),
      item("b", 60_000, pattern),
      item("c", 120_000),
      ...Array.from({ length: 6 }, (_, i) => item(`z${i}`, 200_000 + i * 60_000)),
    ];
    // With the default top of 10, rank utility falls 0.027 per place; the largest
    // novelty penalty short of redundancy is 0.2 x 0.4 = 0.08, worth about 3 places.
    const wide = { ...CONFIG, top: 10, lookahead: 2 };
    const result = selectDiverse(ranked, wide);
    expect(result.selected.map((s) => s.id).slice(0, 4)).toEqual(["a", "c", "z0", "b"]);
    expect(result.deferred).toEqual([]);
    const strict = selectDiverse(ranked, { ...wide, lambda: 1 });
    expect(strict.selected.map((s) => s.id).slice(0, 3)).toEqual(["a", "b", "c"]);
  });

  it("never picks a lower-tier clip ahead of a better-ranked higher-tier one for novelty", () => {
    const pattern = { hookKind: "slap", tension: "pending-decision", speakers: new Set(["X"]) };
    const ranked = [
      item("a", 0, { ...pattern, tier: "excellent" }),
      item("b", 60_000, { ...pattern, tier: "excellent" }),
      item("c", 120_000, { tier: "usable" }),
    ];
    expect(selectDiverse(ranked, CONFIG).selected.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  describe("story beats retold across episodes", () => {
    const docs = [
      {
        id: "pier",
        story: "Mara drops the ledger and runs along the pier.",
        description: "Kade holds a flare gun to Mara's temple on the burning pier.",
      },
      {
        id: "pier2",
        story: "Waves crash. Mara stumbles and screams at him to stop.",
        description: "On the burning pier Kade presses the flare gun against Mara's temple.",
      },
      {
        id: "chapel",
        story: "Mara lights a candle in the empty chapel.",
        description: "Mara finds a hidden letter behind the chapel altar.",
      },
      {
        id: "kitchen",
        story: "Mara slaps the table and spills the soup.",
        description: "Mara accuses her sister in the kitchen of stealing the deed.",
      },
    ];
    const vectors = narrativeVectors(docs);
    const beat = (id: string, episode: number, startMs: number) =>
      item(id, startMs, { episode, narrative: vectors.get(id) });

    it("treats the same beat in another episode as a repeat, with no shared footage", () => {
      const ranked = [beat("pier", 31, 0), beat("pier2", 32, 40_000), beat("chapel", 40, 0)];
      const result = selectDiverse(ranked, CONFIG);
      expect(result.selected.map((s) => s.id)).toEqual(["pier", "chapel"]);
      expect(result.alternates).toEqual([
        expect.objectContaining({
          id: "pier2",
          redundantWith: "pier",
          similarity: expect.objectContaining({ basis: "narrative" }),
        }),
      ]);
    });

    it("keeps clips with the same characters but different incidents", () => {
      const ranked = [beat("chapel", 1, 0), beat("kitchen", 2, 0), beat("pier", 3, 0)];
      const result = selectDiverse(ranked, CONFIG);
      expect(result.selected.map((s) => s.id)).toEqual(["chapel", "kitchen", "pier"]);
      expect(result.alternates).toEqual([]);
    });

    it("ignores narrative text when it was not supplied", () => {
      const plain = [item("pier", 0, { episode: 31 }), item("pier2", 40_000, { episode: 32 })];
      expect(selectDiverse(plain, CONFIG).selected.map((s) => s.id)).toEqual(["pier", "pier2"]);
    });

    it("does not change the quality of the clip that stays", () => {
      const ranked = [beat("pier", 31, 0), beat("pier2", 32, 40_000)];
      expect(selectDiverse(ranked, CONFIG).selected[0]?.listPosition).toBe(1);
      expect(similarity(ranked[0] as DiversityItem, ranked[1] as DiversityItem).basis).not.toBe(
        "narrative",
      );
    });
  });

  it("returns fewer than top when the list runs out", () => {
    expect(selectDiverse([item("a", 0)], CONFIG).selected).toHaveLength(1);
    expect(selectDiverse([], CONFIG).selected).toEqual([]);
  });
});
