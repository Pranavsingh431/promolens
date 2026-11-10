import { describe, expect, it } from "vitest";

import { ferryShow, ferryTimeline } from "../../../tests/support/ranking";
import { createTimeline } from "../screenplay/timeline";
import { clipContext, clipView, lineCuts } from "./windows";

const WINDOWS = { hookMs: 3_000, endingMs: 3_000 };
const CUTS = { substantialCutMs: 1_000, substantialCutShare: 0.3 };
const ids = (events: Array<{ eventId: string }>) => events.map((e) => e.eventId);

describe("the opening is exactly the events on screen in the first three seconds", () => {
  // Episode 1, 00:05.00 to 00:30.00. The opening is source time 5.0 to 8.0 s.
  const view = clipView(ferryTimeline, [{ episode: 1, startMs: 5_000, endMs: 30_000 }], WINDOWS);

  it("includes a shot already running at the cut and lines that start inside 3 s", () => {
    expect(ids(view.opening)).toEqual(["E001-0003", "E001-0004", "E001-0005"]);
    const shot = view.events.find((e) => e.eventId === "E001-0003");
    expect(shot).toMatchObject({ startMs: 0, endMs: 4_000, cutAtStart: true, inOpening: true });
  });

  it("leaves out an event that starts exactly at 3 s", () => {
    // #6 starts at 9.0 s source time, 4.0 s into the clip; a clip starting at 6.0 s puts it at 3.0 s.
    const later = clipView(ferryTimeline, [{ episode: 1, startMs: 6_000, endMs: 30_000 }], WINDOWS);
    const six = later.events.find((e) => e.eventId === "E001-0006");
    expect(six?.startMs).toBe(3_000);
    expect(six?.inOpening).toBe(false);
  });

  it("numbers events in playback order and keeps source ids off the model-facing refs", () => {
    expect(view.events.map((e) => e.ref).slice(0, 4)).toEqual(["C1", "C2", "C3", "C4"]);
    expect(view.events.every((e) => !e.ref.includes("E0"))).toBe(true);
  });
});

describe("the ending is exactly the events on screen in the final three seconds", () => {
  const view = clipView(ferryTimeline, [{ episode: 1, startMs: 5_000, endMs: 30_000 }], WINDOWS);

  it("takes events overlapping source time 27.0 to 30.0 s, in time order", () => {
    // #14 (a shot from 26.0 s) starts before #13 (a line from 26.5 s).
    expect(ids(view.ending)).toEqual(["E001-0014", "E001-0013", "E001-0015"]);
  });

  it("marks a line still going at the cut", () => {
    const line = view.events.find((e) => e.eventId === "E001-0015");
    expect(line).toMatchObject({ endMs: 25_000, cutAtEnd: true, inEnding: true });
  });
});

describe("multi-segment clips use one playback clock", () => {
  const segments = [
    { episode: 1, startMs: 5_000, endMs: 15_000 },
    { episode: 2, startMs: 30_000, endMs: 40_000 },
  ];
  const view = clipView(ferryTimeline, segments, WINDOWS);

  it("continues times and refs across segments, in playback order", () => {
    expect(view.durationMs).toBe(20_000);
    const firstOfSecond = view.events.find((e) => e.segment === 1);
    expect(firstOfSecond).toMatchObject({ episode: 2, startMs: 10_000 });
    expect(view.events.map((e) => e.ref)).toEqual(view.events.map((_, i) => `C${i + 1}`));
  });

  it("takes the ending from the last segment", () => {
    expect(ids(view.ending)).toEqual(["E002-0007"]);
  });

  it("gives the same events as eventsForSegments, in the same order", () => {
    const expected = ferryTimeline
      .eventsForSegments(segments)
      .flatMap((part) => part.events.map((e) => e.id));
    expect(ids(view.events)).toEqual(expected);
  });
});

describe("context outside a clip is only ever read from on-screen events", () => {
  const segments = [{ episode: 1, startMs: 10_000, endMs: 30_000 }];
  const context = clipContext(ferryTimeline, segments, { contextEvents: 3, contextMs: 8_000 });

  it("gives earlier events with negative times and later events after the end", () => {
    expect(context.before.map((e) => [e.ref, e.eventId, e.startMs])).toEqual([
      ["B1", "E001-0003", -5_500],
      ["B2", "E001-0004", -4_800],
      ["B3", "E001-0005", -2_600],
    ]);
    expect(context.after.map((e) => [e.ref, e.eventId, e.startMs])).toEqual([
      ["A1", "E001-0016", 22_000],
    ]);
  });

  it("never carries writer notes, even though the episode has them", () => {
    const episode = ferryShow.episodes[0];
    expect(episode?.writerNotes.logline).toBeTruthy();
    const view = clipView(ferryTimeline, segments, WINDOWS);
    const text = JSON.stringify({ view, context });
    expect(text).not.toContain(episode?.writerNotes.logline ?? "missing");
    expect(text).not.toContain(episode?.writerNotes.continuityNotes ?? "missing");
  });
});

describe("cut spoken lines", () => {
  it("call a cut of 1 s or more substantial", () => {
    const segments = [{ episode: 1, startMs: 5_000, endMs: 30_000 }];
    const view = clipView(ferryTimeline, segments, WINDOWS);
    expect(lineCuts(view, segments, CUTS)).toEqual([
      expect.objectContaining({
        edge: "end",
        eventId: "E001-0015",
        cutMs: 1_500,
        substantial: true,
      }),
    ]);
  });

  it("treat a small trim of a line as minor", () => {
    // #4 runs 5.2 to 7.0 s; starting at 5.5 s cuts 0.3 s, a sixth of the line.
    const segments = [{ episode: 1, startMs: 5_500, endMs: 26_000 }];
    const view = clipView(ferryTimeline, segments, WINDOWS);
    expect(lineCuts(view, segments, CUTS)).toEqual([
      expect.objectContaining({
        edge: "start",
        eventId: "E001-0004",
        cutMs: 300,
        substantial: false,
      }),
    ]);
  });

  it("report nothing when edges fall between lines", () => {
    const segments = [{ episode: 1, startMs: 4_500, endMs: 26_000 }];
    expect(lineCuts(clipView(ferryTimeline, segments, WINDOWS), segments, CUTS)).toEqual([]);
  });

  it("works on a fresh timeline built from the same show", () => {
    const again = createTimeline(ferryShow);
    const segments = [{ episode: 3, startMs: 0, endMs: 24_500 }];
    expect(clipView(again, segments, WINDOWS).events.length).toBeGreaterThan(0);
  });
});
