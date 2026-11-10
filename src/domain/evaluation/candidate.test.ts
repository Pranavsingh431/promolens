import { describe, expect, it } from "vitest";

import { clipKey, intervalIoU, parseClipKey, rankCandidates, type Candidate } from "./candidate";

const candidate = (
  score: number | null,
  episode: number,
  startMs: number,
  endMs: number,
): Candidate => {
  const segments = [{ episode, startMs, endMs, eventIds: [] }];
  const key = clipKey(segments);
  return {
    id: `test:${key}`,
    clipKey: key,
    method: "test",
    methodVersion: "1",
    rank: 1,
    score,
    segments,
    durationMs: endMs - startMs,
    adjustments: [],
    cues: [],
  };
};

describe("clipKey", () => {
  it("is readable, sortable, and reversible", () => {
    const segments = [
      { episode: 12, startMs: 12_340, endMs: 45_670 },
      { episode: 3, startMs: 0, endMs: 5_000 },
    ];
    expect(clipKey(segments)).toBe("E012@0012340-0045670+E003@0000000-0005000");
    expect(parseClipKey(clipKey(segments))).toEqual(segments);
  });
});

describe("intervalIoU", () => {
  it("measures overlap in the same episode only", () => {
    const a = [{ episode: 1, startMs: 0, endMs: 30_000 }];
    expect(intervalIoU(a, a)).toBe(1);
    expect(intervalIoU(a, [{ episode: 1, startMs: 15_000, endMs: 45_000 }])).toBeCloseTo(1 / 3, 10);
    expect(intervalIoU(a, [{ episode: 1, startMs: 30_000, endMs: 50_000 }])).toBe(0);
    expect(intervalIoU(a, [{ episode: 2, startMs: 0, endMs: 30_000 }])).toBe(0);
  });

  it("adds up overlap across segments", () => {
    const a = [
      { episode: 1, startMs: 0, endMs: 10_000 },
      { episode: 2, startMs: 0, endMs: 10_000 },
    ];
    const b = [{ episode: 2, startMs: 5_000, endMs: 15_000 }];
    // Overlap 5 s; union 20 + 10 - 5 = 25 s.
    expect(intervalIoU(a, b)).toBeCloseTo(0.2, 10);
  });
});

describe("rankCandidates", () => {
  it("breaks score ties the same way whatever the input order", () => {
    const items = [
      candidate(3, 2, 10_000, 40_000),
      candidate(5, 4, 0, 30_000),
      candidate(3, 1, 50_000, 80_000),
      candidate(3, 1, 20_000, 50_000),
      candidate(null, 1, 0, 30_000),
    ];
    const forward = rankCandidates(items).map((c) => [c.rank, c.clipKey]);
    const backward = rankCandidates([...items].reverse()).map((c) => [c.rank, c.clipKey]);
    expect(forward).toEqual(backward);
    expect(forward).toEqual([
      [1, "E004@0000000-0030000"],
      [2, "E001@0020000-0050000"],
      [3, "E001@0050000-0080000"],
      [4, "E002@0010000-0040000"],
      [5, "E001@0000000-0030000"],
    ]);
  });
});
