import { describe, expect, it } from "vitest";

import type { JudgmentRecord } from "./annotation";
import { clipKey } from "./candidate";
import {
  consolidate,
  evaluateEpisode,
  evaluateList,
  evaluateMethod,
  labelRanking,
  type MetricOptions,
} from "./metrics";
import { judgmentSchema, type Judgment } from "./rubric";

const OPTIONS: MetricOptions = { k: 3, matchIoU: 0.5, duplicateIoU: 0.5 };

const judge = (kind: "usable" | "strong" | "excellent" | "reject"): Judgment => {
  const ratings = {
    usable: [2, 2, 2, 2, 2],
    strong: [3, 3, 3, 2, 2],
    excellent: [4, 4, 3, 3, 3],
    reject: [1, 1, 1, 1, 1],
  }[kind];
  return judgmentSchema.parse({
    ratings: {
      hook: ratings[0],
      cliffhanger: ratings[1],
      clarity: ratings[2],
      emotion: ratings[3],
      boundaries: ratings[4],
    },
    decision: kind === "reject" ? "reject" : "keep",
    mainReason: kind === "reject" ? "flat" : "all-round",
    weaknesses: [],
    notes: "",
  });
};

const span = (startS: number, endS: number, episode = 1) => [
  { episode, startMs: startS * 1000, endMs: endS * 1000 },
];

const pick = (id: string, rank: number, startS: number, endS: number, episode = 1) => {
  const segments = span(startS, endS, episode).map((s) => ({ ...s, eventIds: [] }));
  return { id, rank, clipKey: clipKey(segments), segments };
};

const partB = (
  reviewer: string,
  startS: number,
  endS: number,
  kind: Parameters<typeof judge>[0],
  episode = 1,
): JudgmentRecord => ({
  reviewer,
  source: "part-b",
  clipKey: clipKey(span(startS, endS, episode)),
  segments: span(startS, endS, episode),
  judgment: judge(kind),
});

const partA = (
  reviewer: string,
  startS: number,
  endS: number,
  kind: Parameters<typeof judge>[0],
  episode = 1,
): JudgmentRecord => ({
  ...partB(reviewer, startS, endS, kind, episode),
  source: "part-a",
});

const refs = (records: JudgmentRecord[], completeReviewers: string[] = []) => ({
  verdicts: consolidate(records),
  partA: records.filter((r) => r.source === "part-a"),
  completeReviewers,
});

describe("unjudged picks", () => {
  it("are skipped rather than counted as misses", () => {
    const picks = [
      pick("a", 1, 0, 30),
      pick("b", 2, 40, 70),
      pick("c", 3, 80, 110),
      pick("d", 4, 120, 150),
    ];
    const result = evaluateEpisode(
      1,
      picks,
      refs([
        partB("R1", 0, 30, "strong"),
        partB("R1", 80, 110, "reject"),
        partB("R1", 120, 150, "usable"),
      ]),
      OPTIONS,
    );
    expect(result.labels.map((l) => l.status)).toEqual([
      "relevant",
      "unjudged",
      "not-relevant",
      "relevant",
    ]);
    // Counting the unjudged pick as a miss would give 1/3. The first three judged picks give 2/3.
    expect(result.precisionAtK).toBeCloseTo(2 / 3, 10);
    expect(result.judgedAtK).toBeCloseTo(2 / 3, 10);
  });

  it("make editorial metrics unavailable when nothing is judged", () => {
    const result = evaluateEpisode(1, [pick("a", 1, 0, 30)], refs([]), OPTIONS);
    expect(result).toMatchObject({
      precisionAtK: null,
      ndcgAtK: null,
      recallAtK: null,
      judgedAtK: 0,
    });
    expect(result.unavailable).toContain("no judged picks");
  });
});

describe("several picks of one moment", () => {
  const reference = partA("R1", 10, 40, "strong");
  const picks = [pick("a", 1, 10, 40), pick("b", 2, 12, 42), pick("c", 3, 11, 39)];

  it("count once; the repeats earn nothing", () => {
    const result = evaluateEpisode(1, picks, refs([reference], ["R1"]), OPTIONS);
    expect(result.labels.map((l) => [l.status, l.duplicateOf])).toEqual([
      ["relevant", null],
      ["redundant", "a"],
      ["redundant", "a"],
    ]);
    // Three picks of one good moment are one useful pick out of three, not 3/3.
    expect(result.precisionAtK).toBeCloseTo(1 / 3, 10);
    expect(result.recallAtK).toBe(1);
  });

  it("stay unjudged when the moment they repeat is unjudged", () => {
    const labels = labelRanking(picks, refs([]), OPTIONS);
    expect(labels.map((l) => l.status)).toEqual(["unjudged", "unjudged", "unjudged"]);
  });
});

describe("nDCG", () => {
  it("matches a value worked out by hand", () => {
    const records = [
      partB("R1", 0, 30, "strong"),
      partB("R1", 40, 70, "reject"),
      partB("R1", 80, 110, "excellent"),
      partB("R1", 120, 150, "usable"),
    ];
    const picks = [pick("a", 1, 0, 30), pick("b", 2, 40, 70), pick("c", 3, 80, 110)];
    const result = evaluateEpisode(1, picks, refs(records), OPTIONS);
    // DCG = 2/1 + 0/log2(3) + 3/2 = 3.5. Ideal gains 3, 2, 1: 3 + 2/log2(3) + 1/2.
    const ideal = 3 + 2 / Math.log2(3) + 0.5;
    expect(result.ndcgAtK).toBeCloseTo(3.5 / ideal, 10);
  });

  it("is unavailable, not zero, when the references contain no positive clip", () => {
    const result = evaluateEpisode(
      1,
      [pick("a", 1, 0, 30), pick("b", 2, 40, 70)],
      refs([partB("R1", 0, 30, "reject"), partB("R1", 40, 70, "reject")]),
      OPTIONS,
    );
    expect(result.precisionAtK).toBe(0);
    expect(result.ndcgAtK).toBeNull();
    expect(result.unavailable).toContain("no positive references for nDCG");
  });
});

describe("recall and boundary error", () => {
  const records = [
    partA("R1", 10, 40, "strong"),
    partA("R1", 60, 90, "usable"),
    partA("R1", 100, 130, "reject"),
  ];
  const picks = [pick("a", 1, 12, 41), pick("b", 2, 200, 230)];

  it("needs a complete Part A review", () => {
    expect(evaluateEpisode(1, picks, refs(records), OPTIONS).recallAtK).toBeNull();
    // One of the two kept reference moments is found in the top 3. The rejected one does not count.
    expect(evaluateEpisode(1, picks, refs(records, ["R1"]), OPTIONS).recallAtK).toBe(0.5);
  });

  it("measures how far matched edges are from the reviewer's edges", () => {
    const result = evaluateEpisode(1, picks, refs(records), OPTIONS);
    expect(result.boundaryErrors).toEqual([{ startMs: 2_000, endMs: 1_000 }]);
  });
});

describe("consolidate", () => {
  it("keeps a clip on a strict majority and uses the lower median gain", () => {
    const verdicts = consolidate([
      partB("R1", 0, 30, "excellent"),
      partB("R2", 0, 30, "strong"),
      partB("R3", 0, 30, "reject"),
      partB("R1", 40, 70, "strong"),
      partB("R2", 40, 70, "reject"),
    ]);
    expect(verdicts.get(clipKey(span(0, 30)))).toEqual({ relevant: true, gain: 2, reviewers: 3 });
    expect(verdicts.get(clipKey(span(40, 70)))).toEqual({ relevant: false, gain: 0, reviewers: 2 });
  });
});

describe("evaluateMethod", () => {
  it("averages per episode so a long episode does not dominate", () => {
    const picks = [
      pick("a", 1, 0, 30, 1),
      pick("b", 2, 40, 70, 1),
      pick("c", 3, 80, 110, 1),
      pick("d", 4, 0, 30, 2),
    ];
    const records = [
      partB("R1", 0, 30, "strong", 1),
      partB("R1", 40, 70, "strong", 1),
      partB("R1", 80, 110, "strong", 1),
      partB("R1", 0, 30, "reject", 2),
    ];
    const result = evaluateMethod(
      "test",
      picks,
      [2, 1],
      { records, completeEpisodes: [] },
      OPTIONS,
    );
    // Episode 1 scores 3/3 and episode 2 scores 0/1. Per-episode mean 0.5; pooling would say 3/4.
    expect(result.macro.precisionAtK).toEqual({ value: 0.5, episodes: 2 });
    expect(result.episodes.map((e) => e.episode)).toEqual([1, 2]);
  });
});

describe("show-level list metrics", () => {
  const list = [
    pick("a", 1, 0, 30, 1),
    pick("b", 2, 0, 30, 2),
    pick("c", 3, 40, 70, 1),
    pick("d", 4, 0, 30, 3),
  ];
  const records = [
    partB("R1", 0, 30, "excellent", 1),
    partB("R1", 40, 70, "reject", 1),
    partB("R1", 0, 30, "strong", 3),
  ];

  it("read the whole ranking as one list and skip unjudged picks instead of counting them as bad", () => {
    const result = evaluateList(list, [1, 2, 3], { records }, { ...OPTIONS, listK: 3 });
    expect(result.labels.slice(0, 4).map((l) => l.status)).toEqual([
      "relevant",
      "unjudged",
      "not-relevant",
      "relevant",
    ]);
    expect(result.judgedAtK).toBeCloseTo(2 / 3, 9);
    expect(result.unjudgedInTopK).toBe(1);
    // Judged-only: the first three judged picks are a, c, d.
    expect(result.precisionAtK).toBeCloseTo(2 / 3, 9);
    // Gains 3, 0, 2 against the ideal 3, 2.
    const ideal = 3 + 2 / Math.log2(3);
    expect(result.ndcgAtK).toBeCloseTo((3 + 0 + 2 / Math.log2(4)) / ideal, 9);
  });

  it("report metrics as unavailable without labels, never as zero", () => {
    const result = evaluateList(list, [1, 2, 3], { records: [] }, OPTIONS);
    expect(result).toMatchObject({ precisionAtK: null, ndcgAtK: null, judgedAtK: 0 });
    expect(result.unavailable).toEqual(["no judged picks", "no positive references for nDCG"]);
  });

  it("only count episodes in scope", () => {
    const result = evaluateList(list, [2], { records }, OPTIONS);
    expect(result.picks).toBe(1);
    expect(result.precisionAtK).toBeNull();
  });
});
