import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { NIGHT_FERRY } from "../../../tests/support/fixtures";
import { syntheticShow } from "../../../tests/support/synthetic-show";
import { assembleShow } from "../screenplay/assemble-show";
import { parseEpisode } from "../screenplay/parse-episode";
import type { Show } from "../screenplay/schema";
import { createTimeline } from "../screenplay/timeline";
import { UNIFORM_CONFIG, generateCueBased, generateUniform } from "./baselines";
import { candidateSchema } from "./candidate";
import { checkCandidateSet } from "./structural-checks";

const ferry = createTimeline(
  assembleShow(
    "night-ferry",
    NIGHT_FERRY.map(({ name, text }) => parseEpisode({ path: `night-ferry/${name}`, text })),
  ).show as Show,
);

const spans = (candidates: Array<{ segments: Array<{ startMs: number; endMs: number }> }>) =>
  candidates.map((c) => [c.segments[0]?.startMs, c.segments[0]?.endMs]);

describe("both baselines on random shows", () => {
  it("only produce legal, structurally valid, unique clips", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (seed) => {
        const timeline = createTimeline(syntheticShow({ episodes: 4, seed }));
        for (const generation of [generateUniform(timeline), generateCueBased(timeline)]) {
          for (const candidate of generation.candidates) {
            expect(candidateSchema.safeParse(candidate).success).toBe(true);
            expect(candidate.durationMs).toBeGreaterThanOrEqual(20_000);
            expect(candidate.durationMs).toBeLessThanOrEqual(60_000);
          }
          const check = checkCandidateSet(generation, timeline);
          expect(check.valid).toBe(generation.candidates.length);
          expect(new Set(generation.candidates.map((c) => c.clipKey)).size).toBe(
            generation.candidates.length,
          );
          expect(generation.candidates.map((c) => c.rank)).toEqual(
            generation.candidates.map((_, i) => i + 1),
          );
        }
      }),
      { numRuns: 25 },
    );
  });

  it("are deterministic, with stable ids", () => {
    const show = syntheticShow({ episodes: 6, seed: 42 });
    expect(generateUniform(createTimeline(show))).toEqual(generateUniform(createTimeline(show)));
    expect(generateCueBased(createTimeline(show))).toEqual(generateCueBased(createTimeline(show)));
  });
});

describe("uniform baseline", () => {
  it("counts every proposal it drops instead of skipping it silently", () => {
    // Windows start every 15 s. Episode lengths 45, 52.25, and 24.5 s give 3 + 4 + 2 proposals.
    // Three of them would run past the episode end with less than 20 s left.
    const generation = generateUniform(ferry);
    expect(generation.proposals).toBe(9);
    expect(generation.rejected).toEqual({ "too-short-at-episode-end": 3 });
    expect(generation.candidates).toHaveLength(6);
  });

  it("records every boundary move, and the original proposal can be read back from it", () => {
    const timeline = createTimeline(syntheticShow({ episodes: 5, seed: 9 }));
    const moved = generateUniform(timeline).candidates.flatMap((c) => c.adjustments);
    expect(moved.length).toBeGreaterThan(0);
    for (const adjustment of moved) expect(adjustment.fromMs).not.toBe(adjustment.toMs);
    for (const adjustment of moved.filter((a) => a.reason === "start-snapped-to-shot")) {
      expect(adjustment.fromMs % UNIFORM_CONFIG.strideMs).toBe(0);
    }
  });
});

describe("cue baseline", () => {
  it("ends clips on cues and starts them on scene or conflict cues", () => {
    // Episode 1 of the fixture: the episode ends at 00:45, scene 1 ends at 00:20, and a line
    // ending in "?" ends at 00:28. The only start cues are the scene starts at 00:00 and 00:20.
    // 00:00-00:45 scores 4, 00:00-00:28 scores 3 but overlaps the first too much, 00:00-00:20 scores 2.
    const generation = generateCueBased(ferry);
    const episodeOne = generation.candidates.filter((c) => c.segments[0]?.episode === 1);
    expect(spans(episodeOne)).toEqual([
      [0, 45_000],
      [0, 20_000],
    ]);
    expect(episodeOne[0]?.cues).toEqual(["start:scene", "end:episode"]);
    expect(episodeOne.map((c) => c.score)).toEqual([4, 2]);
    expect(generation.rejected["overlaps-higher-scoring"]).toBeGreaterThan(0);
    expect(generation.rejected["no-start-cue-in-range"]).toBeGreaterThan(0);
  });

  it("never puts script text in its cue codes", () => {
    const generation = generateCueBased(createTimeline(syntheticShow({ episodes: 3, seed: 5 })));
    for (const candidate of generation.candidates) {
      for (const cue of candidate.cues) expect(cue).toMatch(/^(start|end):[a-z-]+$/);
    }
  });
});
