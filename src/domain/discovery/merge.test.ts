import { describe, expect, it } from "vitest";

import { NIGHT_FERRY } from "../../../tests/support/fixtures";
import { clipKey, type Candidate, type CandidateSet, type Interval } from "../evaluation/candidate";
import { toSegments } from "../evaluation/structural-checks";
import { assembleShow } from "../screenplay/assemble-show";
import { parseEpisode } from "../screenplay/parse-episode";
import type { Show } from "../screenplay/schema";
import { createTimeline } from "../screenplay/timeline";
import { buildHybridSet, groupDuplicates } from "./merge";

const timeline = createTimeline(
  assembleShow(
    "night-ferry",
    NIGHT_FERRY.map(({ name, text }) => parseEpisode({ path: `night-ferry/${name}`, text })),
  ).show as Show,
);

function candidate(method: string, rank: number, interval: Interval): Candidate {
  const segments = toSegments(timeline, [interval]);
  const key = clipKey(segments);
  return {
    id: `${method}:${key}`,
    clipKey: key,
    method,
    methodVersion: "1",
    rank,
    score: null,
    segments,
    durationMs: interval.endMs - interval.startMs,
    adjustments: [],
    cues: [],
  };
}

const set = (method: string, candidates: Candidate[]): CandidateSet => ({
  method,
  methodVersion: "1",
  packSha256: "e".repeat(64),
  candidates,
  rejected: {},
  proposals: candidates.length,
});

const ai1 = candidate("ai-writer-context", 1, { episode: 1, startMs: 4_500, endMs: 32_000 });
const ai2 = candidate("ai-writer-context", 2, { episode: 1, startMs: 0, endMs: 20_000 });
const cueSame = candidate("cues", 1, { episode: 1, startMs: 4_500, endMs: 31_500 });
const cueEp2 = candidate("cues", 2, { episode: 2, startMs: 0, endMs: 30_000 });
const uniEp1 = candidate("uniform", 1, { episode: 1, startMs: 10_000, endMs: 40_000 });
const uniEp2 = candidate("uniform", 2, { episode: 2, startMs: 0, endMs: 30_000 });
const uniEp3 = candidate("uniform", 3, { episode: 3, startMs: 0, endMs: 24_500 });

describe("groupDuplicates", () => {
  it("joins clips that cover the same moment and keeps every source", () => {
    const groups = groupDuplicates([cueSame, uniEp1, ai2, ai1], timeline);
    const shared = groups.find((g) => g.members.length === 2);
    expect(shared?.methods).toEqual(["ai-writer-context", "cues"]);
    expect(shared?.representative.id).toBe(ai1.id);
    expect(groups).toHaveLength(3);
  });

  it("keeps overlapping clips apart when they tell different moments", () => {
    // 00:00 to 00:20 and 00:10 to 00:40 share only a third of their time.
    const groups = groupDuplicates([ai2, uniEp1], timeline);
    expect(groups.map((g) => g.members.length)).toEqual([1, 1]);
  });

  it("needs shared story events as well as shared time", () => {
    const near = candidate("cues", 3, { episode: 1, startMs: 2_000, endMs: 22_000 });
    expect(groupDuplicates([ai2, near], timeline)).toHaveLength(1);
    expect(
      groupDuplicates([ai2, near], timeline, { timeIoU: 0.7, eventJaccard: 0.95 }),
    ).toHaveLength(2);
  });

  it("gives the same groups whatever the input order", () => {
    const all = [ai1, ai2, cueSame, cueEp2, uniEp1, uniEp2, uniEp3];
    expect(groupDuplicates([...all].reverse(), timeline)).toEqual(groupDuplicates(all, timeline));
  });
});

describe("buildHybridSet", () => {
  const {
    set: hybrid,
    stats,
    groups,
  } = buildHybridSet(
    [
      set("ai-writer-context", [ai1, ai2]),
      set("cues", [cueSame, cueEp2]),
      set("uniform", [uniEp1, uniEp2, uniEp3]),
    ],
    timeline,
    "e".repeat(64),
  );

  it("keeps AI and cue clips, and uses uniform windows only where nothing else exists", () => {
    expect(hybrid.candidates.map((c) => [c.rank, c.segments[0]?.episode, c.derivedFrom])).toEqual([
      [1, 1, ai1.id],
      [2, 1, ai2.id],
      [3, 2, cueEp2.id],
      [4, 3, uniEp3.id],
    ]);
    // The episode 2 cue clip and uniform window are the same interval, so they form one group.
    expect(stats).toEqual({
      groups: 5,
      aiOnly: 1,
      baselineOnly: 3,
      shared: 1,
      uniformFallbackEpisodes: [3],
    });
    expect(groups.find((g) => g.members.length === 2)?.members.map((m) => m.method)).toEqual([
      "ai-writer-context",
      "cues",
    ]);
  });

  it("records where each clip came from without changing its interval", () => {
    const first = hybrid.candidates[0];
    expect(first?.id).toBe(`hybrid:${ai1.clipKey}`);
    expect(first?.method).toBe("hybrid");
    expect(first?.cues).toEqual(["src:ai-writer-context", "src:cues"]);
    expect(first?.segments).toEqual(ai1.segments);
  });
});
