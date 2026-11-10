import type { Interval } from "../evaluation/candidate.ts";
import type { Delivery, EventKind, ScreenplayEvent } from "../screenplay/schema.ts";
import type { Timeline } from "../screenplay/timeline.ts";

/**
 * What a viewer of a clip would actually see, in playback order, built from
 * the canonical events only. Writer notes never enter here.
 *
 * Times are playback milliseconds from the start of the clip. Each event gets
 * a short local reference ("C1", "C2", ...) that model answers use as
 * evidence; source event ids stay on this side and are never sent.
 *
 * The opening is [0, hookMs) and the ending is [duration - endingMs, duration),
 * both half-open like the timeline. An event belongs to a window when its
 * on-screen part overlaps it; a zero-length event at time t belongs when t is
 * inside.
 */

export type ClipEvent = {
  ref: string;
  eventId: string;
  episode: number;
  segment: number;
  kind: EventKind;
  speaker?: string;
  delivery?: Delivery;
  text: string;
  /** Playback time of the part shown in the clip. */
  startMs: number;
  endMs: number;
  /** Episode time of the whole event. */
  sourceStartMs: number;
  sourceEndMs: number;
  /** The event began before the clip (or its segment) starts. */
  cutAtStart: boolean;
  /** The event continues after the clip (or its segment) ends. */
  cutAtEnd: boolean;
  inOpening: boolean;
  inEnding: boolean;
};

/** An event just outside a clip edge. Only the editorial stage sees these, marked as outside. */
export type ContextEvent = Omit<ClipEvent, "inOpening" | "inEnding" | "segment">;

export type ClipView = {
  durationMs: number;
  events: ClipEvent[];
  opening: ClipEvent[];
  ending: ClipEvent[];
};

export type ClipContext = { before: ContextEvent[]; after: ContextEvent[] };

export type WindowOptions = { hookMs: number; endingMs: number };

function touches(startMs: number, endMs: number, from: number, to: number): boolean {
  if (startMs === endMs) return startMs >= from && startMs < to;
  return startMs < to && endMs > from;
}

/** Builds the playback view of a clip with eventsForSegments, which never returns writer notes. */
export function clipView(
  timeline: Timeline,
  segments: readonly Interval[],
  options: WindowOptions,
): ClipView {
  const durationMs = segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  const endingFrom = Math.max(0, durationMs - options.endingMs);
  const events: ClipEvent[] = [];
  let offsetMs = 0;

  timeline.eventsForSegments(segments).forEach(({ segment, events: inSegment }, index) => {
    for (const event of inSegment) {
      const startMs = offsetMs + Math.max(event.startMs, segment.startMs) - segment.startMs;
      const endMs = offsetMs + Math.min(event.endMs, segment.endMs) - segment.startMs;
      events.push({
        ref: `C${events.length + 1}`,
        eventId: event.id,
        episode: segment.episode,
        segment: index,
        kind: event.kind,
        ...(event.speaker ? { speaker: event.speaker } : {}),
        ...(event.delivery ? { delivery: event.delivery } : {}),
        text: event.text,
        startMs,
        endMs,
        sourceStartMs: event.startMs,
        sourceEndMs: event.endMs,
        cutAtStart: event.startMs < segment.startMs,
        cutAtEnd: event.endMs > segment.endMs,
        inOpening: touches(startMs, endMs, 0, options.hookMs),
        inEnding: touches(startMs, endMs, endingFrom, durationMs),
      });
    }
    offsetMs += segment.endMs - segment.startMs;
  });

  return {
    durationMs,
    events,
    opening: events.filter((e) => e.inOpening),
    ending: events.filter((e) => e.inEnding),
  };
}

function contextEvent(
  event: ScreenplayEvent,
  ref: string,
  episode: number,
  zeroMs: number,
): ContextEvent {
  return {
    ref,
    eventId: event.id,
    episode,
    kind: event.kind,
    ...(event.speaker ? { speaker: event.speaker } : {}),
    ...(event.delivery ? { delivery: event.delivery } : {}),
    text: event.text,
    startMs: event.startMs - zeroMs,
    endMs: event.endMs - zeroMs,
    sourceStartMs: event.startMs,
    sourceEndMs: event.endMs,
    cutAtStart: false,
    cutAtEnd: false,
  };
}

/**
 * Events just before the first segment and just after the last one, at most
 * `contextEvents` on each side and within `contextMs` of the edge. Times are
 * on the clip's playback clock, so events before the clip have negative
 * times. Refs are "B1".. (earliest first) and "A1".. (earliest first).
 */
export function clipContext(
  timeline: Timeline,
  segments: readonly Interval[],
  options: { contextEvents: number; contextMs: number },
): ClipContext {
  const first = segments[0];
  const last = segments.at(-1);
  if (!first || !last) return { before: [], after: [] };
  const durationMs = segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);

  const before = timeline
    .boundaryContext(first.episode, first.startMs, options.contextEvents)
    .before.filter((e) => e.endMs >= first.startMs - options.contextMs)
    .map((e, i) => contextEvent(e, `B${i + 1}`, first.episode, first.startMs));

  const lastZero = last.startMs - (durationMs - (last.endMs - last.startMs));
  const after = timeline
    .boundaryContext(last.episode, last.endMs, options.contextEvents)
    .after.filter((e) => e.startMs <= last.endMs + options.contextMs)
    .map((e, i) => contextEvent(e, `A${i + 1}`, last.episode, lastZero));

  return { before, after };
}

/** A stable description of exactly what a clip shows, for cache keys. */
export function clipFingerprintSource(segments: readonly Interval[], view: ClipView) {
  return {
    segments: segments.map((s) => [s.episode, s.startMs, s.endMs]),
    events: view.events.map((e) => [
      e.eventId,
      e.kind,
      e.startMs,
      e.endMs,
      e.speaker ?? null,
      e.delivery ?? null,
      e.text,
    ]),
  };
}

export type LineCut = {
  segment: number;
  edge: "start" | "end";
  eventId: string;
  ref: string;
  /** Milliseconds of the spoken line that fall outside the segment at this edge. */
  cutMs: number;
  share: number;
  substantial: boolean;
};

/**
 * Spoken lines that segment edges cut, and by how much. Overlapping lines in
 * the source can make a small cut unavoidable, so only cuts at or above the
 * configured length or share count as substantial.
 */
export function lineCuts(
  view: ClipView,
  segments: readonly Interval[],
  options: { substantialCutMs: number; substantialCutShare: number },
): LineCut[] {
  const cuts: LineCut[] = [];
  for (const event of view.events) {
    const segment = segments[event.segment];
    if (event.kind !== "dialogue" || !segment) continue;
    const length = Math.max(1, event.sourceEndMs - event.sourceStartMs);
    const add = (edge: "start" | "end", cutMs: number) => {
      const share = cutMs / length;
      cuts.push({
        segment: event.segment,
        edge,
        eventId: event.eventId,
        ref: event.ref,
        cutMs,
        share,
        substantial: cutMs >= options.substantialCutMs || share >= options.substantialCutShare,
      });
    };
    if (event.cutAtStart) add("start", segment.startMs - event.sourceStartMs);
    if (event.cutAtEnd) add("end", event.sourceEndMs - segment.endMs);
  }
  return cuts;
}
