import { describe, expect, it } from "vitest";

import { buildDemoResults } from "@/demo/results";

import {
  activeFilters,
  episodesIn,
  NO_FILTERS,
  selectRows,
  withoutFilter,
  type Filters,
} from "./promo-filters";
import { buildResultsModel, type PromoRow } from "./results-model";

// The made-up demo show: five recommendations, one of them in two segments (episodes 1 and 3).
const rows = buildResultsModel(buildDemoResults("complete")).recommended;
const ranks = (list: PromoRow[]) => list.map((row) => row.displayRank);
const filter = (changes: Partial<Filters>, query = "") =>
  ranks(selectRows(rows, query, { ...NO_FILTERS, ...changes }, "recommended"));

/** A copy of a row with a different promo, for cases the demo does not cover. */
function variant(row: PromoRow, changes: Record<string, unknown>, rank: number): PromoRow {
  return {
    ...row,
    id: `${row.id}-${rank}`,
    displayRank: rank,
    promo: { ...row.promo, ...changes },
  };
}

describe("filtering promos", () => {
  it("keeps every promo, in ranked order, when nothing is chosen", () => {
    expect(filter({})).toEqual([1, 2, 3, 4, 5]);
  });

  it("matches a multi-segment promo when any of its segments is in a chosen episode", () => {
    expect(filter({ episodes: [3] })).toEqual([2, 3]);
    expect(filter({ episodes: [1] })).toEqual([1, 2]);
    expect(filter({ episodes: [1, 2] })).toEqual([1, 2, 4, 5]);
  });

  it("uses the total length across every segment", () => {
    const first = rows[0] as PromoRow;
    const split = variant(
      first,
      {
        durationMs: 34_000,
        segments: [
          { episode: 1, startMs: 0, endMs: 17_000, start: "00:00.00", end: "00:17.00" },
          { episode: 2, startMs: 0, endMs: 17_000, start: "00:00.00", end: "00:17.00" },
        ],
      },
      9,
    );
    const list = [...rows, split];
    const by = (durations: Filters["durations"]) =>
      ranks(selectRows(list, "", { ...NO_FILTERS, durations }, "recommended"));
    expect(by(["31-45"])).toEqual([9]);
    expect(by(["20-30"])).toEqual([1, 2, 3, 4, 5]);
    expect(by(["46-60"])).toEqual([]);
    expect(by(["20-30", "31-45"])).toEqual([1, 2, 3, 4, 5, 9]);
  });

  it("applies score and criterion minimums", () => {
    expect(filter({ minScore: 80 })).toEqual([1, 2, 3]);
    expect(filter({ minScore: 90 })).toEqual([1]);
    expect(filter({ minHook: 4 })).toEqual([1, 2]);
    expect(filter({ minCliffhanger: 4 })).toEqual([1, 3, 4]);
    expect(filter({ minClarity: 3 })).toEqual([1, 2, 3, 5]);
  });

  it("separates promos that need a check from those that do not", () => {
    expect(filter({ review: "needs-check" })).toEqual([3, 4, 5]);
    expect(filter({ review: "clear" })).toEqual([1, 2]);
  });

  it("separates single and multi-segment promos", () => {
    expect(filter({ segments: "multi" })).toEqual([2]);
    expect(filter({ segments: "single" })).toEqual([1, 3, 4, 5]);
  });

  it("combines every filter and the search", () => {
    expect(filter({ episodes: [1, 3], minCliffhanger: 4 })).toEqual([1, 3]);
    expect(filter({ episodes: [1, 3], minCliffhanger: 4, review: "clear" })).toEqual([1]);
    expect(filter({ episodes: [2] }, "cargo")).toEqual([]);
  });

  it("returns nothing, without failing, when no promo matches", () => {
    expect(filter({ minScore: 90, segments: "multi" })).toEqual([]);
  });

  it("lists the active filters and removes them one at a time or all at once", () => {
    const chosen: Filters = { ...NO_FILTERS, episodes: [3, 1], minScore: 80, review: "clear" };
    expect(activeFilters(chosen).map((f) => f.label)).toEqual([
      "Episodes 1, 3",
      "Score 80+",
      "Nothing to check",
    ]);
    const fewer = withoutFilter(chosen, "episodes");
    expect(activeFilters(fewer)).toHaveLength(2);
    expect(activeFilters(NO_FILTERS)).toEqual([]);
    expect(ranks(selectRows(rows, "", NO_FILTERS, "recommended"))).toEqual([1, 2, 3, 4, 5]);
  });

  it("offers only episodes that appear in the results", () => {
    expect(episodesIn(rows)).toEqual([1, 2, 3]);
  });
});

describe("searching promos", () => {
  it("finds an episode by number in several spellings", () => {
    expect(filter({}, "3")).toEqual([2, 3]);
    expect(filter({}, "episode 3")).toEqual([2, 3]);
    expect(filter({}, "Ep 2")).toEqual([4, 5]);
  });

  it("searches the hook, the ending, and why it works, ignoring case", () => {
    const first = rows[0] as PromoRow;
    const words = (text: string) => text.split(/\s+/).filter((w) => w.length > 5);
    for (const text of [
      first.promo.hook.explanation,
      first.promo.cliffhanger.explanation,
      first.promo.whyItWorks,
    ]) {
      const word = words(text)[0] as string;
      expect(filter({}, word.toUpperCase())).toContain(1);
    }
    expect(filter({}, "zzzz-not-in-any-promo")).toEqual([]);
  });
});

describe("ordering promos", () => {
  const order = (sort: Parameters<typeof selectRows>[3], list = rows) =>
    ranks(selectRows(list, "", NO_FILTERS, sort));

  it("sorts by each measure and keeps every promo's own rank", () => {
    expect(order("score")).toEqual([1, 2, 3, 4, 5]);
    expect(order("hook")).toEqual([1, 2, 3, 4, 5]);
    expect(order("cliffhanger")).toEqual([1, 3, 4, 2, 5]);
    expect(order("clarity")).toEqual([1, 2, 3, 5, 4]);
    expect(order("shortest")).toEqual([5, 2, 1, 3, 4]);
    expect(order("longest")).toEqual([4, 3, 1, 2, 5]);
    // By first segment: episode 1 (ranks 1 and 2, by start time), then 2, then 3.
    const byEpisode = selectRows(rows, "", NO_FILTERS, "episode");
    const starts = byEpisode.map((row) => row.promo.segments[0]?.episode);
    expect(starts).toEqual([1, 1, 2, 2, 3]);
    expect(ranks(byEpisode).at(-1)).toBe(3);
  });

  it("never changes the stored list or the promos in it", () => {
    const before = JSON.stringify(rows);
    selectRows(rows, "cargo", { ...NO_FILTERS, minScore: 70 }, "longest");
    expect(JSON.stringify(rows)).toBe(before);
    expect(ranks(rows)).toEqual([1, 2, 3, 4, 5]);
  });

  it("puts a promo with a missing score or rating last instead of failing", () => {
    const first = rows[0] as PromoRow;
    const unscored = variant(first, { editorialScore: undefined, criteria: {} }, 6);
    const list = [unscored, ...rows];
    expect(order("score", list).at(-1)).toBe(6);
    expect(order("hook", list).at(-1)).toBe(6);
    expect(
      ranks(selectRows(list, "", { ...NO_FILTERS, minScore: 70 }, "recommended")),
    ).not.toContain(6);
  });
});
