import { z } from "zod";

import type { Episode, Show } from "../screenplay/schema.ts";
import { createRandom, shuffle } from "./random.ts";

/**
 * Deterministic choice of evaluation episodes.
 *
 * 1. Every episode gets a profile computed from its parsed events only.
 * 2. Episodes are grouped by length (short, medium, long thirds) and by series
 *    position (early, middle, late thirds). One episode is drawn at random,
 *    with a fixed seed, from each of the nine groups.
 * 3. If a trait (such as a quiet opening) is still missing, a random episode
 *    with that trait is added. Then random episodes fill up to the target.
 * 4. Episodes are paired by length, and a seeded coin sends one of each pair
 *    to the held-out set, so both sets cover the same range of lengths.
 *
 * Nothing here looks at how any method performs, so the sample cannot favour
 * one.
 */

export const SAMPLE_CONFIG = { version: "sample-1", seed: 20261110, target: 12 } as const;

export const TRAITS = [
  "strong-opening",
  "quiet-opening",
  "dialogue-heavy",
  "action-heavy",
  "high-intensity",
  "reveal-lines",
  "continuity",
  "difficult-boundaries",
] as const;
export type Trait = (typeof TRAITS)[number];

const REVEAL_WORDS =
  /\b(the truth|secret|found out|who you really are|real name|is alive|was you|it was you|pregnant|not your|my son|my daughter)\b/i;

export type EpisodeProfile = {
  episode: number;
  durationMs: number;
  length: "short" | "medium" | "long";
  position: "early" | "middle" | "late";
  firstDialogueMs: number | null;
  dialogueShare: number;
  actionShare: number;
  intensity: number;
  revealLines: number;
  continuity: boolean;
  boundaryIssues: number;
  traits: Trait[];
};

export const evaluationSampleSchema = z.object({
  version: z.string(),
  seed: z.number().int(),
  target: z.number().int().positive(),
  packSha256: z.string().regex(/^[0-9a-f]{64}$/),
  episodeCount: z.number().int().positive(),
  episodes: z.array(
    z.object({
      episode: z.number().int().positive(),
      split: z.enum(["development", "held-out"]),
      reason: z.string(),
      length: z.enum(["short", "medium", "long"]),
      position: z.enum(["early", "middle", "late"]),
      traits: z.array(z.enum(TRAITS)),
    }),
  ),
  uncoveredTraits: z.array(z.enum(TRAITS)),
});

export type EvaluationSample = z.infer<typeof evaluationSampleSchema>;
export type Split = EvaluationSample["episodes"][number]["split"];

const LENGTHS = ["short", "medium", "long"] as const;
const POSITIONS = ["early", "middle", "late"] as const;

function third<T>(values: readonly T[], index: number, count: number): T {
  return values[Math.min(values.length - 1, Math.floor((index * 3) / count))] as T;
}

/** Value at the upper quartile, by nearest rank. */
function upperQuartile(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.75) - 1)] ?? 0;
}

function boundaryIssues(episode: Episode): number {
  let issues = 0;
  episode.events.forEach((event, i) => {
    const previous = episode.events[i - 1];
    if (previous && event.startMs < previous.startMs) issues += 1;
  });
  const dialogue = episode.events
    .filter((e) => e.kind === "dialogue")
    .sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
  let latestEnd = -1;
  for (const line of dialogue) {
    if (line.startMs < latestEnd) issues += 1;
    latestEnd = Math.max(latestEnd, line.endMs);
  }
  return issues;
}

export function profileEpisodes(show: Show): EpisodeProfile[] {
  const count = show.episodes.length;
  const byLength = [...show.episodes].sort(
    (a, b) => a.durationMs - b.durationMs || a.number - b.number,
  );

  const raw = show.episodes.map((episode, index) => {
    const dialogue = episode.events.filter((e) => e.kind === "dialogue");
    const total = Math.max(1, episode.events.length);
    const firstDialogue = dialogue.reduce<number | null>(
      (min, e) => (min === null || e.startMs < min ? e.startMs : min),
      null,
    );
    return {
      episode: episode.number,
      durationMs: episode.durationMs,
      length: third(LENGTHS, byLength.indexOf(episode), count),
      position: third(POSITIONS, index, count),
      firstDialogueMs: firstDialogue,
      dialogueShare: dialogue.length / total,
      actionShare:
        episode.events.filter((e) => e.kind === "action" || e.kind === "sound").length / total,
      intensity: dialogue.filter((e) => /[!?]/.test(e.text)).length / Math.max(1, dialogue.length),
      revealLines: dialogue.filter((e) => REVEAL_WORDS.test(e.text)).length,
      continuity: /continuous/i.test(episode.scenes[0]?.timeOfDay ?? ""),
      boundaryIssues: boundaryIssues(episode),
    };
  });

  const high = (
    key: "dialogueShare" | "actionShare" | "intensity" | "revealLines" | "boundaryIssues",
  ) => {
    const threshold = upperQuartile(raw.map((p) => p[key]));
    return (p: (typeof raw)[number]) => p[key] > 0 && p[key] >= threshold;
  };
  const checks: Record<Trait, (p: (typeof raw)[number]) => boolean> = {
    "strong-opening": (p) => p.firstDialogueMs !== null && p.firstDialogueMs <= 3_000,
    "quiet-opening": (p) => p.firstDialogueMs === null || p.firstDialogueMs >= 8_000,
    "dialogue-heavy": high("dialogueShare"),
    "action-heavy": high("actionShare"),
    "high-intensity": high("intensity"),
    "reveal-lines": high("revealLines"),
    continuity: (p) => p.continuity,
    "difficult-boundaries": high("boundaryIssues"),
  };
  return raw.map((p) => ({ ...p, traits: TRAITS.filter((trait) => checks[trait](p)) }));
}

export function selectSample(
  show: Show,
  packSha256: string,
  config: { version: string; seed: number; target: number } = SAMPLE_CONFIG,
): EvaluationSample {
  const profiles = profileEpisodes(show);
  const random = createRandom(config.seed);
  const target = Math.min(config.target, profiles.length);
  const chosen = new Map<number, string>();
  const pick = (pool: EpisodeProfile[], reason: string) => {
    const free = shuffle(
      pool.filter((p) => !chosen.has(p.episode)),
      random,
    );
    if (free[0] && chosen.size < target) chosen.set(free[0].episode, reason);
  };

  for (const length of LENGTHS) {
    for (const position of POSITIONS) {
      pick(
        profiles.filter((p) => p.length === length && p.position === position),
        `stratum:${length}-${position}`,
      );
    }
  }
  const has = (trait: Trait) =>
    profiles.some((p) => chosen.has(p.episode) && p.traits.includes(trait));
  for (const trait of TRAITS) {
    if (!has(trait))
      pick(
        profiles.filter((p) => p.traits.includes(trait)),
        `trait:${trait}`,
      );
  }
  while (chosen.size < target) pick(profiles, "fill");

  const selected = profiles
    .filter((p) => chosen.has(p.episode))
    .sort((a, b) => a.durationMs - b.durationMs || a.episode - b.episode);
  const heldOut = new Set<number>();
  for (let i = 0; i + 1 < selected.length; i += 2) {
    const pair = [selected[i], selected[i + 1]];
    const chosenOne = pair[random() < 0.5 ? 0 : 1];
    if (chosenOne) heldOut.add(chosenOne.episode);
  }

  return {
    version: config.version,
    seed: config.seed,
    target: config.target,
    packSha256,
    episodeCount: profiles.length,
    episodes: [...selected]
      .sort((a, b) => a.episode - b.episode)
      .map((p) => ({
        episode: p.episode,
        split: heldOut.has(p.episode) ? "held-out" : "development",
        reason: chosen.get(p.episode) ?? "fill",
        length: p.length,
        position: p.position,
        traits: p.traits,
      })),
    uncoveredTraits: TRAITS.filter((trait) => !has(trait)),
  };
}

export function episodesInSplit(sample: EvaluationSample, split: Split | "all"): number[] {
  return sample.episodes.filter((e) => split === "all" || e.split === split).map((e) => e.episode);
}
