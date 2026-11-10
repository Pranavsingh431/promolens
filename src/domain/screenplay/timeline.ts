import type { Episode, EventKind, Scene, ScreenplayEvent, Show } from "./schema.ts";

/**
 * Read-only index over a parsed show for timestamp queries.
 *
 * Intervals are half-open: [startMs, endMs). An event overlaps a range when it
 * starts before the range ends and ends after the range starts. A zero-length
 * event at time t counts as inside any range that contains t.
 *
 * Each episode keeps its events sorted by start time (source order breaks
 * ties) and remembers its longest event, so a range query is a binary search
 * plus a short scan instead of a pass over the whole show.
 */

export type SegmentRef = { episode: number; startMs: number; endMs: number };

export type Boundary = { ms: number; edge: "start" | "end"; event: ScreenplayEvent };

export type SegmentCheck = {
  ok: boolean;
  problems: Array<"unknown-episode" | "not-integer" | "empty-or-reversed" | "outside-episode">;
  /** Events that the segment start or end would cut in the middle. */
  splitAtStart: ScreenplayEvent[];
  splitAtEnd: ScreenplayEvent[];
};

type EpisodeIndex = {
  episode: Episode;
  chronological: ScreenplayEvent[];
  starts: number[];
  longestEventMs: number;
  boundaries: Boundary[];
  boundaryTimes: number[];
  scenesByStart: Scene[];
  sceneStarts: number[];
};

export type Timeline = ReturnType<typeof createTimeline>;

export function createTimeline(show: Show) {
  const episodes = new Map<number, EpisodeIndex>();
  const events = new Map<string, { event: ScreenplayEvent; episode: Episode }>();
  const scenes = new Map<string, { scene: Scene; episode: Episode }>();

  for (const episode of show.episodes) {
    const chronological = [...episode.events].sort(byStart);
    const boundaries = chronological
      .flatMap((event): Boundary[] => [
        { ms: event.startMs, edge: "start", event },
        { ms: event.endMs, edge: "end", event },
      ])
      .sort((a, b) => a.ms - b.ms || edgeRank(a) - edgeRank(b) || a.event.seq - b.event.seq);

    const scenesByStart = [...episode.scenes].sort((a, b) => a.startMs - b.startMs);

    episodes.set(episode.number, {
      episode,
      chronological,
      starts: chronological.map((event) => event.startMs),
      longestEventMs: Math.max(0, ...chronological.map((e) => e.endMs - e.startMs)),
      boundaries,
      boundaryTimes: boundaries.map((boundary) => boundary.ms),
      scenesByStart,
      sceneStarts: scenesByStart.map((scene) => scene.startMs),
    });
    for (const event of episode.events) events.set(event.id, { event, episode });
    for (const scene of episode.scenes) scenes.set(scene.id, { scene, episode });
  }

  function indexOf(episodeNumber: number): EpisodeIndex {
    const index = episodes.get(episodeNumber);
    if (!index) throw new RangeError(`Episode ${episodeNumber} is not in this show`);
    return index;
  }

  /** Events that overlap [startMs, endMs), or lie fully inside it with mode "within". */
  function eventsInRange(
    episodeNumber: number,
    startMs: number,
    endMs: number,
    options: { mode?: "overlap" | "within"; kinds?: readonly EventKind[] } = {},
  ): ScreenplayEvent[] {
    assertRange(startMs, endMs);
    const index = indexOf(episodeNumber);
    const within = options.mode === "within";
    const from = lowerBound(index.starts, within ? startMs : startMs - index.longestEventMs);
    const found: ScreenplayEvent[] = [];

    for (let i = from; i < index.chronological.length; i++) {
      const event = index.chronological[i];
      if (!event || event.startMs >= endMs) break;
      const matches = within
        ? event.startMs >= startMs && event.endMs <= endMs
        : overlaps(event, startMs, endMs);
      if (matches && (!options.kinds || options.kinds.includes(event.kind))) found.push(event);
    }
    return found;
  }

  /** Events running at an exact moment. */
  function eventsAt(episodeNumber: number, ms: number): ScreenplayEvent[] {
    return eventsInRange(episodeNumber, ms, ms + 1);
  }

  /** The scene whose [start, end) contains ms. The episode's last moment belongs to the last scene. */
  function sceneAt(episodeNumber: number, ms: number): Scene | undefined {
    const { scenesByStart, sceneStarts, episode } = indexOf(episodeNumber);
    for (let i = upperBound(sceneStarts, ms) - 1; i >= 0; i--) {
      const scene = scenesByStart[i];
      if (!scene) continue;
      if (ms < scene.endMs || (ms === episode.durationMs && scene.endMs === ms)) return scene;
    }
    return undefined;
  }

  /** Event starts and ends within windowMs of ms, nearest first in time order. */
  function boundariesNear(
    episodeNumber: number,
    ms: number,
    windowMs: number,
    options: { kinds?: readonly EventKind[] } = {},
  ): Boundary[] {
    const { boundaries, boundaryTimes } = indexOf(episodeNumber);
    const from = lowerBound(boundaryTimes, ms - windowMs);
    const found: Boundary[] = [];
    for (let i = from; i < boundaries.length; i++) {
      const boundary = boundaries[i];
      if (!boundary || boundary.ms > ms + windowMs) break;
      if (!options.kinds || options.kinds.includes(boundary.event.kind)) found.push(boundary);
    }
    return found;
  }

  /**
   * What a cut at ms would touch: events it splits, and the nearest events
   * before and after it.
   */
  function boundaryContext(episodeNumber: number, ms: number, count = 3) {
    const { chronological, starts, longestEventMs } = indexOf(episodeNumber);
    const firstAfter = lowerBound(starts, ms);

    const splits: ScreenplayEvent[] = [];
    for (let i = lowerBound(starts, ms - longestEventMs); i < firstAfter; i++) {
      const event = chronological[i];
      if (event && event.startMs < ms && ms < event.endMs) splits.push(event);
    }

    const before: ScreenplayEvent[] = [];
    for (let i = firstAfter - 1; i >= 0 && before.length < count; i--) {
      const event = chronological[i];
      if (event && event.endMs <= ms) before.unshift(event);
    }

    return { splits, before, after: chronological.slice(firstAfter, firstAfter + count) };
  }

  /** Checks that a segment points at real time in a real episode, and reports what its edges cut. */
  function checkSegment(segment: SegmentRef): SegmentCheck {
    const problems: SegmentCheck["problems"] = [];
    const index = episodes.get(segment.episode);
    if (!index) problems.push("unknown-episode");
    if (!Number.isInteger(segment.startMs) || !Number.isInteger(segment.endMs)) {
      problems.push("not-integer");
    }
    if (segment.endMs <= segment.startMs) problems.push("empty-or-reversed");
    if (index && (segment.startMs < 0 || segment.endMs > index.episode.durationMs)) {
      problems.push("outside-episode");
    }
    if (!index || problems.length > 0) {
      return { ok: false, problems, splitAtStart: [], splitAtEnd: [] };
    }
    return {
      ok: true,
      problems,
      splitAtStart: boundaryContext(segment.episode, segment.startMs, 0).splits,
      splitAtEnd: boundaryContext(segment.episode, segment.endMs, 0).splits,
    };
  }

  /**
   * On-screen events for each segment, in playback order. Writer notes are
   * never included, so this is safe input for a cold-viewer check.
   */
  function eventsForSegments(segments: readonly SegmentRef[]) {
    return segments.map((segment) => ({
      segment,
      events: eventsInRange(segment.episode, segment.startMs, segment.endMs),
    }));
  }

  return {
    show,
    episode: (episodeNumber: number) => episodes.get(episodeNumber)?.episode,
    event: (id: string) => events.get(id)?.event,
    scene: (id: string) => scenes.get(id)?.scene,
    /** All events of an episode in time order (source order breaks ties). */
    chronological: (episodeNumber: number): readonly ScreenplayEvent[] =>
      indexOf(episodeNumber).chronological,
    eventsInScene: (sceneId: string) =>
      scenes.get(sceneId)?.episode.events.filter((event) => event.sceneId === sceneId) ?? [],
    eventsInRange,
    eventsAt,
    sceneAt,
    boundariesNear,
    boundaryContext,
    checkSegment,
    eventsForSegments,
  };
}

function overlaps(event: ScreenplayEvent, startMs: number, endMs: number): boolean {
  if (event.startMs === event.endMs) return event.startMs >= startMs && event.startMs < endMs;
  return event.startMs < endMs && event.endMs > startMs;
}

function byStart(a: ScreenplayEvent, b: ScreenplayEvent): number {
  return a.startMs - b.startMs || a.seq - b.seq;
}

/** At the same instant, an ending comes before a start: one shot ends, the next begins. */
function edgeRank(boundary: Boundary): number {
  return boundary.edge === "end" ? 0 : 1;
}

function assertRange(startMs: number, endMs: number) {
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || endMs < startMs) {
    throw new RangeError(`Invalid range ${startMs} to ${endMs}`);
  }
}

/** First index whose value is >= target. */
function lowerBound(sorted: readonly number[], target: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] ?? 0) < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** First index whose value is > target. */
function upperBound(sorted: readonly number[], target: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] ?? 0) <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}
