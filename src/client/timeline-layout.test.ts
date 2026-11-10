import { describe, expect, it } from "vitest";

import { DEMO_SHOW } from "@/demo/show";

import {
  CONTEXT_MS,
  MAX_RENDERED_EVENTS,
  assignRows,
  buildPromoTimeline,
  buildSegmentLayouts,
} from "./timeline-layout";

const timeline = buildPromoTimeline(DEMO_SHOW.episodes);
const NONE = new Set<string>();
const clipOne = { episode: 1, startMs: 5_000, endMs: 31_000 };

function layout(
  segments = [clipOne],
  mode: "clip" | "episode" = "clip",
  hook: ReadonlySet<string> = NONE,
  ending: ReadonlySet<string> = NONE,
) {
  return buildSegmentLayouts({
    timeline,
    segments,
    hookEventIds: hook,
    endingEventIds: ending,
    mode,
  });
}

describe("assignRows", () => {
  it("stacks overlapping events and reuses a row when one ends as the next starts", () => {
    expect(
      assignRows([
        { startMs: 0, endMs: 10 },
        { startMs: 5, endMs: 15 },
        { startMs: 10, endMs: 20 },
      ]),
    ).toEqual([0, 1, 0]);
  });

  it("never stacks deeper than the limit", () => {
    const same = Array.from({ length: 6 }, () => ({ startMs: 0, endMs: 10 }));
    expect(Math.max(...assignRows(same, 3))).toBe(2);
  });
});

describe("a clip's timeline", () => {
  const [first] = layout();

  it("shows the clip with context either side, in exact proportion", () => {
    expect(first?.window).toEqual({
      startMs: clipOne.startMs - CONTEXT_MS < 0 ? 0 : clipOne.startMs - CONTEXT_MS,
      endMs: clipOne.endMs + CONTEXT_MS,
    });
    expect(first?.clip.leftPercent).toBeCloseTo((5_000 / 37_000) * 100, 8);
    expect(first?.clip.widthPercent).toBeCloseTo((26_000 / 37_000) * 100, 8);
  });

  it("keeps source timing from the canonical events", () => {
    const line = first?.events.find((item) => item.event.startMs === 5_200);
    expect(line?.event.startText).toBe("00:05.20");
    expect(line?.event.endText).toBe("00:08.40");
    expect(line?.promoStartMs).toBe(200);
  });

  it("puts every kind in its own lane", () => {
    expect(first?.lanes.map((lane) => lane.kind)).toEqual([
      "dialogue",
      "action",
      "sound",
      "camera",
    ]);
    for (const lane of first?.lanes ?? []) {
      expect(lane.bars.every((bar) => bar.event.kind === lane.kind)).toBe(true);
    }
  });

  it("marks context as outside the clip and leaves it out of the list", () => {
    const outside = first?.events.filter((item) => !item.inClip) ?? [];
    expect(outside.length).toBeGreaterThan(0);
    expect(first?.listEvents.every((item) => item.inClip)).toBe(true);
  });

  it("only draws a boundary for a scene that starts inside the window", () => {
    expect(first?.scenes.map((s) => s.isBoundary)).toEqual([true, true]);
    const [late] = layout([{ episode: 1, startMs: 40_000, endMs: 70_000 }]);
    expect(late?.scenes[0]?.isBoundary).toBe(false);
  });

  it("drops scene labels that would collide", () => {
    const [near] = layout([{ episode: 2, startMs: 43_000, endMs: 65_000 }]);
    expect(near?.scenes.map((s) => s.showLabel)).toEqual([false, true]);
  });

  it("highlights the evidence it is given", () => {
    const [line] = layout([clipOne], "clip", new Set(["E001-0005"]), new Set(["E001-0017"]));
    expect(line?.events.find((e) => e.event.id === "E001-0005")?.role.hook).toBe(true);
    expect(line?.events.find((e) => e.event.id === "E001-0017")?.role.ending).toBe(true);
  });

  it("shows the whole episode on request", () => {
    const [whole] = layout([clipOne], "episode");
    expect(whole?.window).toEqual({ startMs: 0, endMs: 74_000 });
    expect(whole?.listEvents.length).toBe(DEMO_SHOW.episodes[0]?.events.length);
  });
});

describe("boundary warnings", () => {
  it("finds spoken lines cut at either edge, measured from source times", () => {
    const [cut] = layout([{ episode: 2, startMs: 43_000, endMs: 65_000 }]);
    expect(cut?.cuts.map((c) => [c.edge, c.cutMs, c.substantial])).toEqual([
      ["start", 1_000, true],
      ["end", 2_200, true],
    ]);
  });
});

describe("several segments", () => {
  const segments = [
    { episode: 1, startMs: 49_500, endMs: 62_400 },
    { episode: 3, startMs: 49_400, endMs: 61_000 },
  ];
  const layouts = layout(segments);

  it("lays each one out on its own timeline, in order", () => {
    expect(layouts.map((l) => l.segment.episode)).toEqual([1, 3]);
  });

  it("counts promo time across segments", () => {
    const second = layouts[1]?.events.find((item) => item.inClip);
    expect(second?.promoStartMs).toBeGreaterThanOrEqual(12_900);
  });

  it("puts the opening band in the first segment and the ending band in the last", () => {
    expect(layouts[0]?.hookBand).not.toBeNull();
    expect(layouts[0]?.endingBand).toBeNull();
    expect(layouts[1]?.hookBand).toBeNull();
    expect(layouts[1]?.endingBand).not.toBeNull();
  });
});

describe("a very dense episode", () => {
  it("caps the rendered events and reports how many there were", () => {
    const base = DEMO_SHOW.episodes[0];
    if (!base) throw new Error("fixture");
    const template = base.events[0];
    if (!template) throw new Error("fixture");
    const events = Array.from({ length: MAX_RENDERED_EVENTS + 50 }, (_, i) => ({
      ...template,
      id: `E001-${String(i + 1).padStart(4, "0")}`,
      seq: i + 1,
      startMs: i * 100,
      endMs: i * 100 + 50,
    }));
    const dense = buildPromoTimeline([{ ...base, events, durationMs: 74_000 }]);
    const [result] = buildSegmentLayouts({
      timeline: dense,
      segments: [{ episode: 1, startMs: 0, endMs: 40_000 }],
      hookEventIds: NONE,
      endingEventIds: NONE,
      mode: "episode",
    });
    expect(result?.events).toHaveLength(MAX_RENDERED_EVENTS);
    expect(result?.truncatedFrom).toBe(MAX_RENDERED_EVENTS + 50);
  });
});
