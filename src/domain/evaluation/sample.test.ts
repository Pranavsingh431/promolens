import { describe, expect, it } from "vitest";

import { syntheticShow } from "../../../tests/support/synthetic-show";
import { SAMPLE_CONFIG, episodesInSplit, profileEpisodes, selectSample } from "./sample";

const HASH = "a".repeat(64);
const show = syntheticShow({ episodes: 50, seed: 11 });

describe("selectSample", () => {
  const sample = selectSample(show, HASH);

  it("is deterministic for the same show and seed", () => {
    expect(selectSample(show, HASH)).toEqual(sample);
  });

  it("changes with the seed, so the choice is not hand-picked", () => {
    const other = selectSample(show, HASH, { ...SAMPLE_CONFIG, seed: SAMPLE_CONFIG.seed + 1 });
    expect(other.episodes.map((e) => e.episode)).not.toEqual(sample.episodes.map((e) => e.episode));
  });

  it("picks the target number of distinct episodes and covers every length and position group", () => {
    const numbers = sample.episodes.map((e) => e.episode);
    expect(numbers).toHaveLength(12);
    expect(new Set(numbers).size).toBe(12);
    const groups = new Set(sample.episodes.map((e) => `${e.length}-${e.position}`));
    expect(groups.size).toBe(9);
  });

  it("splits into disjoint development and held-out sets of matched lengths", () => {
    const development = episodesInSplit(sample, "development");
    const heldOut = episodesInSplit(sample, "held-out");
    expect(development).toHaveLength(6);
    expect(heldOut).toHaveLength(6);
    expect(development.filter((e) => heldOut.includes(e))).toEqual([]);
    expect([...development, ...heldOut].sort((a, b) => a - b)).toEqual(
      episodesInSplit(sample, "all"),
    );

    // After sorting by length, every consecutive pair has exactly one held-out episode.
    const durations = new Map(show.episodes.map((e) => [e.number, e.durationMs]));
    const byLength = sample.episodes
      .map((e) => ({ ...e, durationMs: durations.get(e.episode) ?? 0 }))
      .sort((a, b) => a.durationMs - b.durationMs || a.episode - b.episode);
    for (let i = 0; i < byLength.length; i += 2) {
      const pair = byLength.slice(i, i + 2).map((e) => e.split);
      expect(pair.filter((split) => split === "held-out")).toHaveLength(1);
    }
  });

  it("records why each episode was chosen and which traits stay uncovered", () => {
    expect(sample.episodes.every((e) => /^(stratum|trait):|^fill$/.test(e.reason))).toBe(true);
    const covered = new Set(sample.episodes.flatMap((e) => e.traits));
    for (const trait of sample.uncoveredTraits) expect(covered.has(trait)).toBe(false);
  });

  it("takes every episode of a small show", () => {
    const small = selectSample(syntheticShow({ episodes: 3, seed: 2 }), HASH);
    expect(small.episodes.map((e) => e.episode)).toEqual([1, 2, 3]);
    expect(episodesInSplit(small, "held-out")).toHaveLength(1);
  });
});

describe("profileEpisodes", () => {
  it("measures openings and shares from parsed events only", () => {
    const [profile] = profileEpisodes(show);
    const episode = show.episodes[0];
    const dialogue = episode?.events.filter((e) => e.kind === "dialogue") ?? [];
    expect(profile?.firstDialogueMs).toBe(Math.min(...dialogue.map((e) => e.startMs)));
    expect(profile?.dialogueShare).toBeCloseTo(dialogue.length / (episode?.events.length ?? 1), 10);
  });
});
