import { describe, expect, it } from "vitest";

import { DEFAULT_RANKING_CONFIG } from "./config";
import { MAX_FINALISTS, MAX_PROMOS, planRankingConfig, promoCountSchema } from "./plan";

describe("the rank-4 plan", () => {
  it("is rank-3 at 10 promos, apart from its name and the batches", () => {
    const { version, requested, progressive, ...plan } = planRankingConfig(10);
    const { version: base, ...rank3 } = DEFAULT_RANKING_CONFIG;
    expect([version, base, requested]).toEqual(["rank-4", "rank-3", 10]);
    expect(progressive.minBatch).toBeGreaterThan(0);
    expect(plan).toEqual(rank3);
  });

  it("asks for less detailed work for fewer promos and more for more", () => {
    const sizes = [1, 5, 10, 20, 100, 300].map((n) => planRankingConfig(n));
    const shortlists = sizes.map((c) => c.screening.shortlist);
    expect(shortlists).toEqual([...shortlists].sort((a, b) => a - b));
    expect(sizes[0]?.screening.episodeFloor).toBe(false);
    expect(sizes[2]?.screening.episodeFloor).toBe(true);
    expect(sizes.map((c) => c.diversity.top)).toEqual([1, 5, 10, 20, 100, 300]);
  });

  it("keeps head-to-head comparison bounded, however many promos are asked for", () => {
    expect(planRankingConfig(1).pairwise.finalists).toBe(8);
    expect(planRankingConfig(300).pairwise.finalists).toBe(MAX_FINALISTS);
    expect(planRankingConfig(MAX_PROMOS).pairwise.finalists).toBe(MAX_FINALISTS);
  });

  it("refuses counts that are not whole numbers from 1 to the ceiling", () => {
    for (const bad of [0, -3, 2.5, MAX_PROMOS + 1, Number.NaN]) {
      expect(promoCountSchema.safeParse(bad).success).toBe(false);
      expect(() => planRankingConfig(bad)).toThrow();
    }
    expect(promoCountSchema.parse(MAX_PROMOS)).toBe(MAX_PROMOS);
  });
});
