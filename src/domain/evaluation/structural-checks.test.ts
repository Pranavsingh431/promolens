import { describe, expect, it } from "vitest";

import { NIGHT_FERRY } from "../../../tests/support/fixtures";
import { assembleShow } from "../screenplay/assemble-show";
import { parseEpisode } from "../screenplay/parse-episode";
import type { Show } from "../screenplay/schema";
import { createTimeline } from "../screenplay/timeline";
import { clipKey, type Candidate, type Interval } from "./candidate";
import {
  checkCandidate,
  checkCandidateSet,
  proposeBoundaryFix,
  toSegments,
} from "./structural-checks";

const show = assembleShow(
  "night-ferry",
  NIGHT_FERRY.map(({ name, text }) => parseEpisode({ path: `night-ferry/${name}`, text })),
).show as Show;
const timeline = createTimeline(show);

function candidate(intervals: Interval[], rank = 1, overrides: Partial<Candidate> = {}): Candidate {
  const segments = toSegments(timeline, intervals);
  const key = clipKey(segments);
  return {
    id: `test:${key}`,
    clipKey: key,
    method: "test",
    methodVersion: "1",
    rank,
    score: null,
    segments,
    durationMs: segments.reduce((sum, s) => sum + s.endMs - s.startMs, 0),
    adjustments: [],
    cues: [],
    ...overrides,
  };
}

const codes = (c: Candidate) => checkCandidate(c, timeline).map((i) => i.code);
const errors = (c: Candidate) =>
  checkCandidate(c, timeline)
    .filter((i) => i.severity === "error")
    .map((i) => i.code);

describe("checkCandidate", () => {
  it("passes a legal clip that starts and ends on shot changes", () => {
    expect(codes(candidate([{ episode: 1, startMs: 0, endMs: 20_000 }]))).toEqual([]);
  });

  it("rejects a clip from an episode the show does not have", () => {
    // Built by hand, as a model might return it: there are no events to look up.
    const segments = [{ episode: 9, startMs: 0, endMs: 30_000, eventIds: [] }];
    const key = clipKey(segments);
    const outsider = {
      ...candidate([{ episode: 1, startMs: 0, endMs: 30_000 }]),
      id: `test:${key}`,
      clipKey: key,
      segments,
    };
    expect(errors(outsider)).toEqual(["unknown-episode"]);
  });

  it.each([
    [[{ episode: 1, startMs: 30_000, endMs: 50_000 }], "invalid-segment"],
    [[{ episode: 1, startMs: 0, endMs: 19_990 }], "duration-out-of-range"],
    [
      [
        { episode: 2, startMs: 0, endMs: 52_250 },
        { episode: 1, startMs: 0, endMs: 9_000 },
      ],
      "duration-out-of-range",
    ],
  ])("rejects %j with %s", (intervals, code) => {
    expect(errors(candidate(intervals))).toContain(code);
  });

  it("rejects event references that do not match the timeline", () => {
    const good = candidate([{ episode: 1, startMs: 0, endMs: 20_000 }]);
    const tampered = { ...good, segments: [{ ...good.segments[0]!, eventIds: ["E001-0001"] }] };
    expect(errors(tampered)).toEqual(["event-refs-mismatch"]);
  });

  it("rejects a stated duration or id that does not match the segments", () => {
    const good = candidate([{ episode: 1, startMs: 0, endMs: 20_000 }]);
    expect(errors({ ...good, durationMs: 25_000 })).toEqual(["duration-mismatch"]);
    expect(errors({ ...good, id: "test:other" })).toEqual(["id-mismatch"]);
  });

  it("flags a legal clip that starts halfway through a spoken line", () => {
    // 00:10.50 falls inside the captain's line that runs 00:10.00 to 00:12.40.
    const clip = candidate([{ episode: 1, startMs: 10_500, endMs: 40_500 }]);
    const issues = checkCandidate(clip, timeline);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.find((i) => i.code === "starts-mid-dialogue")).toMatchObject({
      severity: "warning",
      eventIds: ["E001-0007"],
    });
  });

  it("rejects segments that reuse footage and notes ones out of story order", () => {
    expect(
      errors(
        candidate([
          { episode: 1, startMs: 0, endMs: 15_000 },
          { episode: 1, startMs: 10_000, endMs: 20_000 },
        ]),
      ),
    ).toEqual(["overlapping-segments"]);
    const reordered = candidate([
      { episode: 1, startMs: 20_000, endMs: 32_000 },
      { episode: 1, startMs: 0, endMs: 9_000 },
    ]);
    expect(errors(reordered)).toEqual([]);
    expect(codes(reordered)).toContain("out-of-story-order");
  });

  it("rejects a clip with no events and warns about one with only camera directions", () => {
    const sparse: Show = {
      title: "sparse",
      episodes: [
        {
          ...show.episodes[2]!,
          durationMs: 60_000,
          scenes: [{ ...show.episodes[2]!.scenes[0]!, endMs: 60_000 }],
          events: [{ ...show.episodes[2]!.events[0]!, startMs: 0, endMs: 25_000 }],
        },
      ],
    };
    const sparseTimeline = createTimeline(sparse);
    const build = (startMs: number, endMs: number) => {
      const segments = toSegments(sparseTimeline, [{ episode: 3, startMs, endMs }]);
      const key = clipKey(segments);
      return {
        ...candidate([{ episode: 1, startMs: 0, endMs: 20_000 }]),
        id: `test:${key}`,
        clipKey: key,
        segments,
        durationMs: endMs - startMs,
      };
    };
    expect(checkCandidate(build(30_000, 60_000), sparseTimeline).map((i) => i.code)).toEqual([
      "no-on-screen-content",
    ]);
    expect(checkCandidate(build(0, 25_000), sparseTimeline).map((i) => i.code)).toEqual([
      "no-dialogue-or-action",
    ]);
  });
});

describe("checkCandidateSet", () => {
  it("marks the lower-ranked copy of a repeated or near-identical interval", () => {
    const first = candidate([{ episode: 1, startMs: 0, endMs: 30_000 }], 1);
    const copy = { ...first, id: "test:copy", rank: 2 };
    const near = candidate([{ episode: 1, startMs: 1_000, endMs: 30_000 }], 3);
    const separate = candidate([{ episode: 2, startMs: 0, endMs: 30_000 }], 4);
    const result = checkCandidateSet({ candidates: [near, separate, copy, first] }, timeline);
    expect(result.byCandidate.get("test:copy")?.map((i) => i.code)).toContain("duplicate-interval");
    expect(result.byCandidate.get(near.id)?.map((i) => i.code)).toContain("near-duplicate");
    expect(result.byCandidate.get(first.id)?.map((i) => i.code)).not.toContain("near-duplicate");
    expect(result.byCandidate.get(separate.id)).toEqual([]);
  });
});

describe("proposeBoundaryFix", () => {
  it("returns a corrected copy and leaves the original proposal untouched", () => {
    const original = candidate([{ episode: 1, startMs: 10_500, endMs: 40_500 }]);
    const snapshot = structuredClone(original);
    const fixed = proposeBoundaryFix(original, timeline);

    expect(original).toEqual(snapshot);
    expect(fixed).toMatchObject({
      derivedFrom: original.id,
      segments: [{ episode: 1, startMs: 10_000, endMs: 40_500 }],
      adjustments: [
        {
          segment: 0,
          edge: "start",
          fromMs: 10_500,
          toMs: 10_000,
          reason: "start-extended-to-whole-line",
        },
      ],
    });
    expect(fixed?.id).not.toBe(original.id);
    expect(checkCandidate(fixed as Candidate, timeline).map((i) => i.code)).not.toContain(
      "starts-mid-dialogue",
    );
  });

  it("returns null when nothing needs fixing", () => {
    expect(
      proposeBoundaryFix(candidate([{ episode: 1, startMs: 0, endMs: 20_000 }]), timeline),
    ).toBeNull();
  });
});
