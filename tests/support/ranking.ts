import { clipKey, type Candidate, type Interval } from "../../src/domain/evaluation/candidate";
import { toSegments } from "../../src/domain/evaluation/structural-checks";
import type { ColdViewerResponse } from "../../src/domain/ranking/prompts/cold-viewer-v1";
import type { EditorialResponse } from "../../src/domain/ranking/prompts/editorial-v1";
import type { PairwiseResponse } from "../../src/domain/ranking/prompts/pairwise-v1";
import type { ScreenResponse } from "../../src/domain/ranking/prompts/screen-v1";
import { assembleShow } from "../../src/domain/screenplay/assemble-show";
import { parseEpisode } from "../../src/domain/screenplay/parse-episode";
import type { Show } from "../../src/domain/screenplay/schema";
import { createTimeline, type Timeline } from "../../src/domain/screenplay/timeline";
import { NIGHT_FERRY } from "./fixtures";

/** Helpers for ranking tests: the synthetic Night Ferry show and model answers that cite real refs. */

export const ferryShow = assembleShow(
  "night-ferry",
  NIGHT_FERRY.map(({ name, text }) => parseEpisode({ path: `night-ferry/${name}`, text })),
).show as Show;
export const ferryTimeline = createTimeline(ferryShow);

export function makeCandidate(
  timeline: Timeline,
  intervals: Interval[],
  options: { method?: string; cues?: string[]; rank?: number } = {},
): Candidate {
  const method = options.method ?? "hybrid";
  const segments = toSegments(timeline, intervals);
  const key = clipKey(segments);
  return {
    id: `${method}:${key}`,
    clipKey: key,
    method,
    methodVersion: "test",
    rank: options.rank ?? 1,
    score: null,
    segments,
    durationMs: segments.reduce((sum, s) => sum + s.endMs - s.startMs, 0),
    adjustments: [],
    cues: options.cues ?? ["src:ai-writer-context"],
  };
}

/** Clip references in a prompt, with the OPENING and ENDING marks the prompt shows. */
export function refsIn(text: string, letter = "C") {
  const all: string[] = [];
  const opening: string[] = [];
  const ending: string[] = [];
  for (const line of text.split("\n")) {
    const match = new RegExp(`^(${letter}\\d+) \\[[^\\]]*\\]((?: OPENING| ENDING)*) `).exec(line);
    if (!match?.[1]) continue;
    all.push(match[1]);
    if (match[2]?.includes("OPENING")) opening.push(match[1]);
    if (match[2]?.includes("ENDING")) ending.push(match[1]);
  }
  return { all, opening, ending };
}

/** A stable small number from a prompt, so different clips get different ratings. */
export function promptLevel(text: string): number {
  let h = 7;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 2 + (h % 3);
}

export function fakeScreen(user: string, overrides: Partial<ScreenResponse> = {}): ScreenResponse {
  const level = promptLevel(user);
  return {
    hook: level,
    cliffhanger: level,
    clarity: 3,
    emotion: 2,
    momentType: "confrontation",
    note: "Quick read.",
    ...overrides,
  };
}

export function fakeCold(
  user: string,
  overrides: Partial<ColdViewerResponse> = {},
): ColdViewerResponse {
  const { all } = refsIn(user);
  const cite = all.slice(0, 2);
  const answer = (text: string) => ({ text, certainty: "clear" as const, evidence: cite });
  return {
    involved: answer("A woman and a captain."),
    happening: answer("She hides; he searches."),
    stakes: answer("Being caught."),
    openQuestion: answer("Will he find her?"),
    missingContext: [],
    wouldCare: { verdict: "yes", reason: "Clear danger." },
    guesses: [],
    clarity: 3,
    ...overrides,
  };
}

export function fakeEditorial(
  user: string,
  overrides: Partial<EditorialResponse> = {},
): EditorialResponse {
  const clip = /<clip>([\s\S]*?)<\/clip>/.exec(user)?.[1] ?? user;
  const { all, opening, ending } = refsIn(clip);
  const level = promptLevel(clip);
  return {
    hook: {
      rating: level,
      opening: "A voice calls out in the dark.",
      evidence: opening.slice(0, 1),
      surprise: "dialogue",
      question: "Who is hiding?",
      needsPriorContext: false,
    },
    cliffhanger: {
      rating: level,
      ending: "The question hangs.",
      evidence: ending.slice(-1),
      tension: "unanswered-question",
      falseCliffhanger: "none",
      reasonToContinue: "To see what happens.",
    },
    emotion: { rating: 2, evidence: all.slice(0, 1), note: "Fear." },
    boundaries: { rating: 3, start: "clean", end: "clean", note: "" },
    hookKind: "danger",
    whyItWorks: "A hidden stowaway and a searching captain.",
    warnings: [],
    correction: { propose: false, startRef: "", endRef: "", reason: "" },
    ...overrides,
  };
}

export function fakePair(overrides: Partial<PairwiseResponse> = {}): PairwiseResponse {
  return {
    winner: "A",
    margin: "clear",
    criteria: { hook: "A", cliffhanger: "A", clarity: "tie", emotion: "A", boundaries: "tie" },
    reason: "A opens harder.",
    ...overrides,
  };
}
