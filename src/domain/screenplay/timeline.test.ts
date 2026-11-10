import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { NIGHT_FERRY } from "../../../tests/support/fixtures";
import { assembleShow } from "./assemble-show";
import { parseEpisode } from "./parse-episode";
import type { Episode, EventKind, ScreenplayEvent, Show } from "./schema";
import { createTimeline } from "./timeline";

function fixtureShow(): Show {
  const results = NIGHT_FERRY.map(({ name, text }) =>
    parseEpisode({ path: `night-ferry/${name}`, text }),
  );
  const { show } = assembleShow("night-ferry", results);
  if (!show) throw new Error("Fixture show did not parse");
  return show;
}

const show = fixtureShow();
const timeline = createTimeline(show);
const ids = (events: readonly ScreenplayEvent[]) => events.map((event) => event.id);

describe("lookups", () => {
  it("finds episodes, scenes, and events by id", () => {
    expect(timeline.episode(2)?.id).toBe("E002");
    expect(timeline.scene("E001-S02")?.timeOfDay).toBe("CONTINUOUS");
    expect(timeline.event("E003-0003")).toMatchObject({ speaker: "STRANGER", startMs: 7_000 });
    expect(timeline.event("E009-0001")).toBeUndefined();
    expect(ids(timeline.eventsInScene("E002-S02"))).toEqual([
      "E002-0007",
      "E002-0008",
      "E002-0009",
      "E002-0010",
    ]);
  });

  it("orders events by time while the episode keeps source order", () => {
    const chronological = timeline.chronological(1);
    const starts = chronological.map((event) => event.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(ids([...chronological].sort((a, b) => a.seq - b.seq))).toEqual(
      ids(show.episodes[0]?.events ?? []),
    );
    // The out-of-order camera (source position 14) comes before the purser line (13) in time.
    const at = chronological.findIndex((event) => event.id === "E001-0014");
    expect(chronological[at + 1]?.id).toBe("E001-0013");
  });
});

describe("time queries", () => {
  it("returns events that overlap a range, or only those fully inside it", () => {
    // E001-0003 ends at 9.000 and E001-0008 starts at 12.000, so neither overlaps.
    expect(ids(timeline.eventsInRange(1, 9_000, 12_000))).toEqual([
      "E001-0005",
      "E001-0006",
      "E001-0007",
    ]);
    expect(ids(timeline.eventsInRange(1, 9_000, 14_000, { mode: "within" }))).toEqual([
      "E001-0006",
      "E001-0007",
      "E001-0008",
    ]);
    expect(ids(timeline.eventsInRange(1, 0, 45_000, { kinds: ["sound"] }))).toEqual([
      "E001-0009",
      "E001-0017",
    ]);
  });

  it("treats ranges as half-open", () => {
    expect(ids(timeline.eventsInRange(2, 5_000, 5_000))).toEqual([]);
    expect(ids(timeline.eventsAt(2, 5_000))).toEqual(["E002-0003"]);
    expect(ids(timeline.eventsAt(2, 4_999))).toEqual(["E002-0001"]);
  });

  it("finds the scene at a timestamp, including the episode's final moment", () => {
    expect(timeline.sceneAt(1, 0)?.id).toBe("E001-S01");
    expect(timeline.sceneAt(1, 19_999)?.id).toBe("E001-S01");
    expect(timeline.sceneAt(1, 20_000)?.id).toBe("E001-S02");
    expect(timeline.sceneAt(1, 45_000)?.id).toBe("E001-S02");
    expect(timeline.sceneAt(1, 45_001)).toBeUndefined();
  });

  it("lists nearby event boundaries in time order, optionally by kind", () => {
    const near = timeline.boundariesNear(1, 9_000, 400, { kinds: ["camera"] });
    expect(near.map((b) => [b.ms, b.edge, b.event.id])).toEqual([
      [9_000, "end", "E001-0003"],
      [9_000, "start", "E001-0006"],
    ]);
    const all = timeline.boundariesNear(1, 12_000, 500).map((b) => b.ms);
    expect(all).toEqual([...all].sort((a, b) => a - b));
    expect(all.every((ms) => ms >= 11_500 && ms <= 12_500)).toBe(true);
  });

  it("shows which events a cut would split, and what is around it", () => {
    const context = timeline.boundaryContext(1, 11_000, 2);
    expect(ids(context.splits)).toEqual(["E001-0006", "E001-0007"]);
    expect(ids(context.before)).toEqual(["E001-0004", "E001-0005"]);
    expect(ids(context.after)).toEqual(["E001-0008", "E001-0009"]);
  });
});

describe("segment references", () => {
  it("accepts a valid segment and reports the lines its edges would cut", () => {
    const check = timeline.checkSegment({ episode: 1, startMs: 11_000, endMs: 41_000 });
    expect(check.ok).toBe(true);
    expect(ids(check.splitAtStart)).toEqual(["E001-0006", "E001-0007"]);
    expect(ids(check.splitAtEnd)).toEqual(["E001-0016"]);
  });

  it.each([
    [{ episode: 7, startMs: 0, endMs: 20_000 }, ["unknown-episode"]],
    [{ episode: 1, startMs: 20_000, endMs: 20_000 }, ["empty-or-reversed"]],
    [{ episode: 1, startMs: 30_000, endMs: 10_000 }, ["empty-or-reversed"]],
    [{ episode: 1, startMs: 30_000, endMs: 50_000 }, ["outside-episode"]],
    [{ episode: 1, startMs: 0.5, endMs: 30_000 }, ["not-integer"]],
  ])("rejects %j", (segment, problems) => {
    expect(timeline.checkSegment(segment)).toMatchObject({ ok: false, problems });
  });

  it("returns on-screen events per segment in playback order, never writer notes", () => {
    const result = timeline.eventsForSegments([
      { episode: 2, startMs: 30_000, endMs: 40_000 },
      { episode: 1, startMs: 0, endMs: 5_000 },
    ]);
    expect(result.map((part) => part.segment.episode)).toEqual([2, 1]);
    expect(ids(result[1]?.events ?? [])).toEqual(["E001-0001", "E001-0002", "E001-0003"]);
    const serialized = JSON.stringify(result);
    for (const episode of show.episodes) {
      if (episode.writerNotes.logline)
        expect(serialized).not.toContain(episode.writerNotes.logline);
      if (episode.writerNotes.continuityNotes) {
        expect(serialized).not.toContain(episode.writerNotes.continuityNotes);
      }
    }
  });
});

describe("range queries match a brute-force scan", () => {
  const KINDS: EventKind[] = ["camera", "action", "sound", "dialogue"];

  const randomEpisode = fc
    .array(
      fc.record({
        start: fc.integer({ min: 0, max: 60_000 }),
        length: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 15_000 })),
        kind: fc.constantFrom(...KINDS),
      }),
      { minLength: 1, maxLength: 80 },
    )
    .map((specs): Episode => {
      const events = specs.map((spec, index): ScreenplayEvent => {
        const base = {
          id: `E001-${String(index + 1).padStart(4, "0")}`,
          seq: index + 1,
          sceneId: "E001-S01",
          kind: spec.kind,
          startMs: spec.start,
          endMs: spec.start + spec.length,
          startText: "x",
          endText: "x",
          text: "",
          notes: [],
          line: index + 1,
          endLine: index + 1,
        };
        return spec.kind === "dialogue" ? { ...base, speaker: "A", delivery: "on-screen" } : base;
      });
      const durationMs = Math.max(...events.map((event) => event.endMs));
      return {
        id: "E001",
        number: 1,
        sourceFile: "x.txt",
        durationMs,
        writerNotes: { otherFields: [] },
        scenes: [
          {
            id: "E001-S01",
            number: 1,
            heading: "",
            startMs: 0,
            endMs: durationMs,
            startText: null,
            endText: null,
            line: 1,
          },
        ],
        events,
      };
    });

  const range = fc
    .tuple(fc.integer({ min: -5_000, max: 80_000 }), fc.integer({ min: 0, max: 30_000 }))
    .map(([start, length]) => [start, start + length] as const);

  it("for overlap and within queries, with and without kind filters", () => {
    fc.assert(
      fc.property(randomEpisode, range, fc.subarray(KINDS), (episode, [a, b], kinds) => {
        const t = createTimeline({ title: "random", episodes: [episode] });
        const isZero = (e: ScreenplayEvent) => e.startMs === e.endMs;
        const overlap = episode.events.filter((e) =>
          isZero(e) ? e.startMs >= a && e.startMs < b : e.startMs < b && e.endMs > a,
        );
        // Half-open ranges: a zero-length event is inside [a, b) only when a <= t < b,
        // in both modes. (This oracle once let a point at exactly b count as within,
        // which disagreed with the documented rule; see the explicit case below.)
        const within = episode.events.filter((e) =>
          isZero(e) ? e.startMs >= a && e.startMs < b : e.startMs >= a && e.endMs <= b,
        );
        const sorted = (events: ScreenplayEvent[]) =>
          ids([...events].sort((x, y) => x.startMs - y.startMs || x.seq - y.seq));

        expect(ids(t.eventsInRange(1, a, b))).toEqual(sorted(overlap));
        expect(ids(t.eventsInRange(1, a, b, { mode: "within" }))).toEqual(sorted(within));
        expect(ids(t.eventsInRange(1, a, b, { kinds }))).toEqual(
          sorted(overlap.filter((e) => kinds.includes(e.kind))),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("treat a zero-length event at exactly the range end as outside, in both modes", () => {
    // The counterexample fast-check found on 2026-11-10 (seed -143588303).
    const point = (id: string, seq: number, ms: number): ScreenplayEvent => ({
      id,
      seq,
      sceneId: "E001-S01",
      kind: "camera",
      startMs: ms,
      endMs: ms,
      startText: "x",
      endText: "x",
      text: "",
      notes: [],
      line: seq,
      endLine: seq,
    });
    const t = createTimeline({
      title: "edge",
      episodes: [
        {
          id: "E001",
          number: 1,
          sourceFile: "x.txt",
          durationMs: 29_997,
          writerNotes: { otherFields: [] },
          scenes: [
            {
              id: "E001-S01",
              number: 1,
              heading: "",
              startMs: 0,
              endMs: 29_997,
              startText: null,
              endText: null,
              line: 1,
            },
          ],
          events: [point("E001-0001", 1, 29_997), point("E001-0002", 2, 0)],
        },
      ],
    });
    expect(ids(t.eventsInRange(1, 3, 29_997))).toEqual([]);
    expect(ids(t.eventsInRange(1, 3, 29_997, { mode: "within" }))).toEqual([]);
    expect(ids(t.eventsInRange(1, 0, 29_997, { mode: "within" }))).toEqual(["E001-0002"]);
    expect(ids(t.eventsInRange(1, 3, 29_998, { mode: "within" }))).toEqual(["E001-0001"]);
  });

  it("for cut splits", () => {
    fc.assert(
      fc.property(randomEpisode, fc.integer({ min: 0, max: 80_000 }), (episode, ms) => {
        const t = createTimeline({ title: "random", episodes: [episode] });
        const expected = episode.events.filter((e) => e.startMs < ms && ms < e.endMs);
        expect(new Set(ids(t.boundaryContext(1, ms).splits))).toEqual(new Set(ids(expected)));
      }),
      { numRuns: 300 },
    );
  });
});

describe("guards", () => {
  it("rejects invalid ranges and unknown episodes", () => {
    expect(() => timeline.eventsInRange(1, 10, 5)).toThrow(RangeError);
    expect(() => timeline.eventsInRange(1, 0.5, 5)).toThrow(RangeError);
    expect(() => timeline.eventsInRange(99, 0, 5)).toThrow(RangeError);
  });
});
