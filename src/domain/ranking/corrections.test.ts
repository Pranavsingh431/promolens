import { describe, expect, it } from "vitest";

import { fakeEditorial, ferryTimeline, makeCandidate } from "../../../tests/support/ranking";
import { checkCandidate } from "../evaluation/structural-checks";
import { proposeCorrection } from "./corrections";
import { clipContext, clipView } from "./windows";

const original = makeCandidate(ferryTimeline, [{ episode: 1, startMs: 4_500, endMs: 30_000 }]);
const view = clipView(ferryTimeline, original.segments, { hookMs: 3_000, endingMs: 3_000 });
const context = clipContext(ferryTimeline, original.segments, {
  contextEvents: 3,
  contextMs: 8_000,
});
const ref = (eventId: string) => view.events.find((e) => e.eventId === eventId)?.ref ?? "";
const correction = (startRef: string, endRef: string) => ({
  ...fakeEditorial("").correction,
  propose: true,
  startRef,
  endRef,
  reason: "Start on the challenge.",
});

describe("boundary corrections", () => {
  it("build a new, checked clip from cited events and leave the original alone", () => {
    const before = structuredClone(original);
    // Start on the captain's line (#4 at 5.2 s); keep the end.
    const result = proposeCorrection(
      original,
      correction(ref("E001-0004"), ""),
      view,
      context,
      ferryTimeline,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.segments[0]).toMatchObject({
      episode: 1,
      startMs: 5_200,
      endMs: 30_000,
    });
    expect(result.candidate.id).not.toBe(original.id);
    expect(result.candidate.derivedFrom).toBe(original.id);
    expect(result.candidate.adjustments.at(-1)).toMatchObject({
      edge: "start",
      fromMs: 4_500,
      toMs: 5_200,
      reason: "editorial-correction",
    });
    expect(
      checkCandidate(result.candidate, ferryTimeline).filter((i) => i.severity === "error"),
    ).toEqual([]);
    expect(original).toEqual(before);
  });

  it("can extend the end onto an event just after the clip", () => {
    const result = proposeCorrection(original, correction("", "A1"), view, context, ferryTimeline);
    expect(result.ok && result.candidate.segments[0]?.endMs).toBe(45_000);
  });

  it("refuse references that do not exist or point the wrong way", () => {
    expect(
      proposeCorrection(original, correction("C99", ""), view, context, ferryTimeline),
    ).toEqual({
      ok: false,
      reason: "unknown-start-ref",
    });
    // An after-clip event cannot become the start.
    expect(proposeCorrection(original, correction("A1", ""), view, context, ferryTimeline)).toEqual(
      {
        ok: false,
        reason: "unknown-start-ref",
      },
    );
  });

  it("refuse a clip outside 20 to 60 s instead of bending it", () => {
    const short = proposeCorrection(
      original,
      correction(ref("E001-0012"), ""),
      view,
      context,
      ferryTimeline,
    );
    expect(short).toEqual({ ok: false, reason: "too-short" });
  });

  it("do nothing when nothing is proposed or nothing changes", () => {
    expect(
      proposeCorrection(
        original,
        { ...correction("", ""), propose: false },
        view,
        context,
        ferryTimeline,
      ),
    ).toEqual({ ok: false, reason: "not-proposed" });
    expect(proposeCorrection(original, correction("", ""), view, context, ferryTimeline)).toEqual({
      ok: false,
      reason: "no-edge-given",
    });
  });

  it("do not attempt multi-segment clips", () => {
    const multi = makeCandidate(ferryTimeline, [
      { episode: 1, startMs: 5_000, endMs: 15_000 },
      { episode: 2, startMs: 30_000, endMs: 40_000 },
    ]);
    const multiView = clipView(ferryTimeline, multi.segments, { hookMs: 3_000, endingMs: 3_000 });
    expect(
      proposeCorrection(multi, correction("C2", ""), multiView, context, ferryTimeline),
    ).toEqual({
      ok: false,
      reason: "multi-segment-not-supported",
    });
  });
});
