import type { Interval } from "@/domain/evaluation/candidate";
import { DEFAULT_RANKING_CONFIG } from "@/domain/ranking/config";
import { clipView, lineCuts, type LineCut } from "@/domain/ranking/windows";
import type { EventKind, Episode, Scene, ScreenplayEvent } from "@/domain/screenplay/schema";
import { createTimeline, type Timeline } from "@/domain/screenplay/timeline";

/**
 * Positions for the screenplay timeline. Every position derives from the
 * canonical integer-millisecond times. Percentages exist only for CSS: the
 * timecodes shown to an editor come from the source text or from those
 * integers, never from a measured pixel.
 */

export const LANES: ReadonlyArray<{ kind: EventKind; label: string }> = [
  { kind: "dialogue", label: "Dialogue" },
  { kind: "action", label: "Action" },
  { kind: "sound", label: "Sound" },
  { kind: "camera", label: "Camera" },
];

/** Time shown either side of a clip, so an editor can see what the cut leaves out. */
export const CONTEXT_MS = 6_000;
/** Overlapping events in one lane stack this deep at most. Every event stays in the list below. */
export const MAX_LANE_ROWS = 3;
/**
 * The largest real episode has 121 events, so plain rendering is fine. This cap
 * only guards the DOM against an unusually dense show.
 */
export const MAX_RENDERED_EVENTS = 300;
const MIN_BAR_PERCENT = 0.5;
/** Scene labels need room: they are dropped rather than drawn over each other or the edge. */
const MIN_LABEL_GAP_PERCENT = 12;
const MAX_LABEL_PERCENT = 86;

export type TimelineMode = "clip" | "episode";

export type TimelineRole = { hook: boolean; ending: boolean };

export type TimelineEvent = {
  event: ScreenplayEvent;
  inClip: boolean;
  role: TimelineRole;
  cut: LineCut | null;
  /** Seconds into the promo where this event appears, when it is in the clip. */
  promoStartMs: number | null;
};

export type TimelineBar = TimelineEvent & {
  leftPercent: number;
  widthPercent: number;
  row: number;
  /** False for context shown around the clip, which is not in the event list. */
  selectable: boolean;
};

export type TimelineLane = {
  kind: EventKind;
  label: string;
  rows: number;
  bars: TimelineBar[];
};

export type SegmentLayout = {
  index: number;
  segment: Interval;
  window: { startMs: number; endMs: number };
  clip: { leftPercent: number; widthPercent: number };
  hookBand: { leftPercent: number; widthPercent: number } | null;
  endingBand: { leftPercent: number; widthPercent: number } | null;
  ticks: Array<{ ms: number; leftPercent: number }>;
  scenes: Array<{
    scene: Scene;
    leftPercent: number;
    /** False when the scene began before this window, so no real boundary is in view. */
    isBoundary: boolean;
    showLabel: boolean;
  }>;
  lanes: TimelineLane[];
  /** Everything in the window, in time order. */
  events: TimelineEvent[];
  /** What the event list and arrow keys cover: the clip alone, or the whole episode. */
  listEvents: TimelineEvent[];
  truncatedFrom: number | null;
  cuts: LineCut[];
};

export function buildPromoTimeline(episodes: readonly Episode[]): Timeline {
  return createTimeline({ title: "promo", episodes: [...episodes] });
}

/** Stacks overlapping intervals. Each takes the first row free at its start time. */
export function assignRows(
  items: ReadonlyArray<{ startMs: number; endMs: number }>,
  maxRows = MAX_LANE_ROWS,
): number[] {
  const rowEnds: number[] = [];
  return items.map(({ startMs, endMs }) => {
    let row = rowEnds.findIndex((end) => end <= startMs);
    if (row === -1) row = rowEnds.length < maxRows ? rowEnds.length : maxRows - 1;
    rowEnds[row] = Math.max(rowEnds[row] ?? 0, endMs);
    return row;
  });
}

function tickStep(spanMs: number): number {
  if (spanMs <= 45_000) return 5_000;
  if (spanMs <= 120_000) return 15_000;
  if (spanMs <= 300_000) return 30_000;
  return 60_000;
}

/** The part of a promo-time window that falls inside one segment, in episode time. */
function bandInSegment(
  fromPromoMs: number,
  toPromoMs: number,
  segmentStartPromoMs: number,
  segment: Interval,
): { startMs: number; endMs: number } | null {
  const length = segment.endMs - segment.startMs;
  const start = Math.max(fromPromoMs, segmentStartPromoMs);
  const end = Math.min(toPromoMs, segmentStartPromoMs + length);
  if (end <= start) return null;
  return {
    startMs: segment.startMs + (start - segmentStartPromoMs),
    endMs: segment.startMs + (end - segmentStartPromoMs),
  };
}

export function buildSegmentLayouts(input: {
  timeline: Timeline;
  segments: readonly Interval[];
  hookEventIds: ReadonlySet<string>;
  endingEventIds: ReadonlySet<string>;
  mode: TimelineMode;
}): SegmentLayout[] {
  const { timeline, segments, hookEventIds, endingEventIds, mode } = input;
  const { windows, boundaries } = DEFAULT_RANKING_CONFIG;
  const view = clipView(timeline, segments, windows);
  const allCuts = lineCuts(view, segments, boundaries);

  let promoOffset = 0;
  return segments.map((segment, index) => {
    const segmentStartPromo = promoOffset;
    promoOffset += segment.endMs - segment.startMs;

    const episode = timeline.episode(segment.episode);
    const durationMs = episode?.durationMs ?? segment.endMs;
    const window =
      mode === "episode"
        ? { startMs: 0, endMs: Math.max(durationMs, segment.endMs) }
        : {
            startMs: Math.max(0, segment.startMs - CONTEXT_MS),
            endMs: Math.min(durationMs, segment.endMs + CONTEXT_MS),
          };
    const span = window.endMs - window.startMs;
    const percent = (ms: number) =>
      Math.min(100, Math.max(0, ((ms - window.startMs) / span) * 100));
    const band = (range: { startMs: number; endMs: number } | null) =>
      range
        ? {
            leftPercent: percent(range.startMs),
            widthPercent: percent(range.endMs) - percent(range.startMs),
          }
        : null;

    const inView = new Map(
      view.events.filter((e) => e.segment === index).map((e) => [e.eventId, e] as const),
    );
    const cuts = allCuts.filter((cut) => cut.segment === index);
    const cutById = new Map(cuts.map((cut) => [cut.eventId, cut] as const));

    const found = timeline.eventsInRange(segment.episode, window.startMs, window.endMs);
    const shown = found.slice(0, MAX_RENDERED_EVENTS);
    const events: TimelineEvent[] = shown.map((event) => {
      const onScreen = inView.get(event.id);
      return {
        event,
        inClip: onScreen !== undefined,
        role: { hook: hookEventIds.has(event.id), ending: endingEventIds.has(event.id) },
        cut: cutById.get(event.id) ?? null,
        promoStartMs: onScreen?.startMs ?? null,
      };
    });

    const lanes = LANES.map(({ kind, label }) => {
      const ofKind = events.filter((item) => item.event.kind === kind);
      const rows = assignRows(ofKind.map((item) => item.event));
      const bars = ofKind.map((item, i): TimelineBar => {
        const leftPercent = percent(item.event.startMs);
        return {
          ...item,
          leftPercent,
          widthPercent: Math.max(percent(item.event.endMs) - leftPercent, MIN_BAR_PERCENT),
          row: rows[i] ?? 0,
          selectable: mode === "episode" || item.inClip,
        };
      });
      return { kind, label, rows: Math.max(1, ...rows.map((r) => r + 1)), bars };
    });

    const step = tickStep(span);
    const ticks: SegmentLayout["ticks"] = [];
    for (let ms = Math.ceil(window.startMs / step) * step; ms <= window.endMs; ms += step) {
      ticks.push({ ms, leftPercent: percent(ms) });
    }

    const inWindow = (episode?.scenes ?? [])
      .filter((scene) => scene.startMs < window.endMs && scene.endMs > window.startMs)
      .map((scene) => ({ scene, leftPercent: percent(scene.startMs) }));
    const scenes = inWindow.map((item, i) => {
      const next = inWindow[i + 1];
      return {
        ...item,
        isBoundary: item.scene.startMs >= window.startMs,
        showLabel:
          item.leftPercent <= MAX_LABEL_PERCENT &&
          (next === undefined || next.leftPercent - item.leftPercent >= MIN_LABEL_GAP_PERCENT),
      };
    });

    return {
      index,
      segment,
      window,
      clip: {
        leftPercent: percent(segment.startMs),
        widthPercent: percent(segment.endMs) - percent(segment.startMs),
      },
      hookBand: band(bandInSegment(0, windows.hookMs, segmentStartPromo, segment)),
      endingBand: band(
        bandInSegment(
          Math.max(0, view.durationMs - windows.endingMs),
          view.durationMs,
          segmentStartPromo,
          segment,
        ),
      ),
      ticks,
      scenes,
      lanes,
      events,
      listEvents: mode === "episode" ? events : events.filter((item) => item.inClip),
      truncatedFrom: found.length > shown.length ? found.length : null,
      cuts,
    };
  });
}
