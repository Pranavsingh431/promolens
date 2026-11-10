import type { Episode, ScreenplayEvent } from "../screenplay/schema.ts";
import type { Timeline } from "../screenplay/timeline.ts";
import {
  DURATION_LIMITS,
  clipKey,
  intervalDurationMs,
  intervalIoU,
  rankCandidates,
  type Adjustment,
  type Candidate,
  type CandidateSet,
  type Interval,
} from "./candidate.ts";
import { createRandom, shuffle } from "./random.ts";
import { fixDialogueSplits, toSegments } from "./structural-checks.ts";

/**
 * Two deliberately simple baselines. Any later method has to beat them.
 *
 * Uniform: fixed-length windows at a fixed stride, nudged onto nearby shot
 * changes, in a seeded random order. It knows nothing about the story.
 *
 * Cues: ends clips on moments that usually leave a question open (the episode
 * end, a scene end, a line ending in "?" or "!") and starts them on lines or
 * actions that suggest conflict. Rules are generic English cues, not tuned to
 * any show.
 */

export type Generation = Omit<CandidateSet, "packSha256">;

export const UNIFORM_CONFIG = {
  method: "uniform",
  version: "uniform-1",
  windowMs: 30_000,
  strideMs: 15_000,
  snapMs: 2_000,
  seed: 7001,
} as const;

export const CUES_CONFIG = {
  method: "cues",
  version: "cues-1",
  perEpisode: 5,
  maxOverlapIoU: 0.5,
  leadInMs: 1_000,
  targetDurationMs: 35_000,
} as const;

const CLOSING_QUOTES = new Set([
  '"',
  "'",
  String.fromCharCode(0x201d),
  String.fromCharCode(0x2019),
]);
const ELLIPSIS = String.fromCharCode(0x2026);

export const CONFLICT_WORDS =
  /\b(how dare|liar|lied|lying|betray\w*|hate|kill\w*|dead|murder\w*|get out|enough|the truth|secret|who are you|never forgive)\b/i;
export const PHYSICAL_ACTION =
  /\b(slap\w*|punch\w*|struck|strikes?|grab\w*|shov\w*|throw\w*|threw|smash\w*|collaps\w*|scream\w*|stab\w*|shoot\w*|explod\w*|burst\w*|kiss\w*)\b/i;

type Counter = Record<string, number>;
const count = (counter: Counter, reason: string) => {
  counter[reason] = (counter[reason] ?? 0) + 1;
};

function makeCandidate(
  timeline: Timeline,
  config: { method: string; version: string },
  intervals: Interval[],
  adjustments: Adjustment[],
  score: number | null,
  cues: string[],
): Candidate {
  const segments = toSegments(timeline, intervals);
  const key = clipKey(segments);
  return {
    id: `${config.method}:${key}`,
    clipKey: key,
    method: config.method,
    methodVersion: config.version,
    rank: 1,
    score,
    segments,
    durationMs: intervalDurationMs(segments),
    adjustments,
    cues,
  };
}

function isLegal(interval: Interval, episode: Episode): boolean {
  const length = interval.endMs - interval.startMs;
  return (
    interval.startMs >= 0 &&
    interval.endMs <= episode.durationMs &&
    length >= DURATION_LIMITS.minDurationMs &&
    length <= DURATION_LIMITS.maxDurationMs
  );
}

/** Moves one edge to the nearest camera shot change within snapMs, if the clip stays legal. */
function snapToShot(
  timeline: Timeline,
  episode: Episode,
  interval: Interval,
  edge: "start" | "end",
  snapMs: number,
): Adjustment | undefined {
  const key = edge === "start" ? "startMs" : "endMs";
  const at = interval[key];
  const nearest = timeline
    .boundariesNear(episode.number, at, snapMs, { kinds: ["camera"] })
    .filter((boundary) => boundary.edge === edge && boundary.ms !== at)
    .sort((a, b) => Math.abs(a.ms - at) - Math.abs(b.ms - at) || a.ms - b.ms)[0];
  if (!nearest) return undefined;
  const trial = { ...interval, [key]: nearest.ms };
  if (!isLegal(trial, episode)) return undefined;
  interval[key] = nearest.ms;
  return { segment: 0, edge, fromMs: at, toMs: nearest.ms, reason: `${edge}-snapped-to-shot` };
}

export function generateUniform(timeline: Timeline, config = UNIFORM_CONFIG): Generation {
  const rejected: Counter = {};
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let proposals = 0;

  for (const episode of timeline.show.episodes) {
    for (let start = 0; start < episode.durationMs; start += config.strideMs) {
      proposals += 1;
      const interval: Interval = {
        episode: episode.number,
        startMs: start,
        endMs: Math.min(start + config.windowMs, episode.durationMs),
      };
      if (!isLegal(interval, episode)) {
        count(rejected, "too-short-at-episode-end");
        continue;
      }
      const adjustments = (["start", "end"] as const).flatMap((edge) => {
        const moved = snapToShot(timeline, episode, interval, edge, config.snapMs);
        return moved ? [moved] : [];
      });
      const fixed = fixDialogueSplits(timeline, [interval]);
      const key = clipKey(fixed.intervals);
      if (seen.has(key)) {
        count(rejected, "duplicate-after-adjustment");
        continue;
      }
      seen.add(key);
      candidates.push(
        makeCandidate(
          timeline,
          config,
          fixed.intervals,
          [...adjustments, ...fixed.adjustments],
          null,
          ["window:uniform"],
        ),
      );
    }
  }

  // Uniform sampling has no opinion about order, so its ranking is a seeded shuffle.
  const ordered = shuffle(
    [...candidates].sort((a, b) => (a.clipKey < b.clipKey ? -1 : 1)),
    createRandom(config.seed),
  );
  return {
    method: config.method,
    methodVersion: config.version,
    candidates: ordered.map((candidate, index) => ({ ...candidate, rank: index + 1 })),
    rejected,
    proposals,
  };
}

type Cue = { ms: number; score: number; cues: string[] };

function addCue(cues: Map<number, Cue>, ms: number, score: number, code: string) {
  const cue = cues.get(ms) ?? { ms, score: 0, cues: [] };
  cue.score += score;
  if (!cue.cues.includes(code)) cue.cues.push(code);
  cues.set(ms, cue);
}

function spoken(event: ScreenplayEvent): string {
  let text = event.text.trim();
  while (text && CLOSING_QUOTES.has(text.at(-1) ?? "")) text = text.slice(0, -1).trimEnd();
  return text;
}

function endCues(episode: Episode): Cue[] {
  const cues = new Map<number, Cue>();
  addCue(cues, episode.durationMs, 3, "end:episode");
  for (const scene of episode.scenes) {
    if (scene.endMs < episode.durationMs) addCue(cues, scene.endMs, 1, "end:scene");
  }
  for (const event of episode.events) {
    if (event.kind !== "dialogue") continue;
    const text = spoken(event);
    if (text.endsWith("?")) addCue(cues, event.endMs, 2, "end:question");
    else if (text.endsWith("!")) addCue(cues, event.endMs, 1, "end:exclaim");
    else if (text.endsWith("...") || text.endsWith(ELLIPSIS))
      addCue(cues, event.endMs, 1, "end:trailing-off");
  }
  return [...cues.values()].sort((a, b) => a.ms - b.ms);
}

function startCues(timeline: Timeline, episode: Episode, leadInMs: number): Cue[] {
  const cues = new Map<number, Cue>();
  const add = (ms: number, score: number, code: string) => {
    // Start on the shot change just before the cue, so the shot is not cut.
    const shot = timeline
      .boundariesNear(episode.number, ms, leadInMs, { kinds: ["camera"] })
      .filter((b) => b.edge === "start" && b.ms <= ms)
      .at(-1);
    addCue(cues, shot?.ms ?? ms, score, code);
  };
  for (const scene of episode.scenes) add(scene.startMs, 1, "start:scene");
  for (const event of episode.events) {
    if (event.kind === "dialogue") {
      if (spoken(event).includes("!")) add(event.startMs, 1, "start:exclaim");
      if (CONFLICT_WORDS.test(event.text)) add(event.startMs, 1, "start:conflict-words");
    } else if (event.kind === "action" && PHYSICAL_ACTION.test(event.text)) {
      add(event.startMs, 1, "start:physical-action");
    }
  }
  return [...cues.values()].sort((a, b) => a.ms - b.ms);
}

export function generateCueBased(timeline: Timeline, config = CUES_CONFIG): Generation {
  const rejected: Counter = {};
  const all: Candidate[] = [];
  let proposals = 0;

  for (const episode of timeline.show.episodes) {
    const starts = startCues(timeline, episode, config.leadInMs);
    const scored: Candidate[] = [];

    for (const end of endCues(episode)) {
      proposals += 1;
      const best = starts
        .filter((start) => {
          const length = end.ms - start.ms;
          return length >= DURATION_LIMITS.minDurationMs && length <= DURATION_LIMITS.maxDurationMs;
        })
        .sort(
          (a, b) =>
            b.score - a.score ||
            Math.abs(end.ms - a.ms - config.targetDurationMs) -
              Math.abs(end.ms - b.ms - config.targetDurationMs) ||
            a.ms - b.ms,
        )[0];
      if (!best) {
        count(rejected, "no-start-cue-in-range");
        continue;
      }
      const fixed = fixDialogueSplits(timeline, [
        { episode: episode.number, startMs: best.ms, endMs: end.ms },
      ]);
      scored.push(
        makeCandidate(
          timeline,
          config,
          fixed.intervals,
          fixed.adjustments,
          end.score + best.score,
          [...best.cues, ...end.cues],
        ),
      );
    }

    // Keep the best few per episode that do not overlap each other much.
    const kept: Candidate[] = [];
    for (const candidate of rankCandidates(scored)) {
      if (kept.some((k) => k.clipKey === candidate.clipKey)) {
        count(rejected, "duplicate-after-adjustment");
      } else if (
        kept.some((k) => intervalIoU(k.segments, candidate.segments) > config.maxOverlapIoU)
      ) {
        count(rejected, "overlaps-higher-scoring");
      } else if (kept.length >= config.perEpisode) {
        count(rejected, "beyond-per-episode-limit");
      } else {
        kept.push(candidate);
      }
    }
    all.push(...kept);
  }

  return {
    method: config.method,
    methodVersion: config.version,
    candidates: rankCandidates(all),
    rejected,
    proposals,
  };
}
