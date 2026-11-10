import { describe, expect, it } from "vitest";

import {
  describeCost,
  describeDuration,
  estimateAnalysis,
  plannedWork,
  type WorkProfile,
} from "./estimate";

// The deployment's measured profile at concurrency 4, as production ran on 2026-11-10.
import { workProfile } from "../server/analysis/calibration";
import { readLimits, type BackendConfig } from "../server/config";
import { demoWorkProfile } from "./calibration";

const config = (concurrency: number) =>
  ({
    limits: {
      jobBudgetUsd: 1.5,
      rollingBudgetUsd: 15,
      jobMaxRequests: 6_000,
      modelConcurrency: concurrency,
      modelTimeoutMs: 120_000,
      modelAttempts: 3,
      stepBudgetMs: 200_000,
      retentionDays: 30,
    },
  }) as BackendConfig;
const profile = (concurrency = 8): WorkProfile => workProfile(config(concurrency), {});

describe("analysis estimates", () => {
  it("brackets the one full analysis measured in production", () => {
    // A made-up 4-episode show, 10 promos, concurrency 4 and discovery batches of 8:
    // 172 seconds, 87 model requests, $0.0366 billed.
    const e = estimateAnalysis(
      { ...profile(4), discoveryBatch: 8 },
      // 10 KB of script text in 4 episodes.
      { episodes: 4, textKb: 10, requested: 10 },
    );
    expect(e.timeMs?.low).toBeLessThanOrEqual(172_000);
    expect(e.timeMs?.high).toBeGreaterThanOrEqual(172_000);
    expect(e.costUsd?.low).toBeLessThanOrEqual(0.0366);
    expect(e.costUsd?.high).toBeGreaterThanOrEqual(0.0366);
    expect(e.requests.low).toBeLessThanOrEqual(92);
  });

  it("brackets the supplied pack's recorded cost for 10 promos", () => {
    // Discovery $0.14 and ranking $0.23 in the recorded full-show runs: about $0.37.
    const e = estimateAnalysis(profile(), { episodes: 50, textKb: 516.6, requested: 10 });
    expect(e.costUsd?.low).toBeLessThanOrEqual(0.37);
    expect(e.costUsd?.high).toBeGreaterThanOrEqual(0.37);
  });

  it("grows with the request, but never from zero: discovery and screening are fixed", () => {
    const at = (n: number) =>
      estimateAnalysis(profile(), { episodes: 50, textKb: 516.6, requested: n });
    const one = at(1);
    const many = at(300);
    expect(one.work.low.discovery).toBe(100);
    expect(one.work.low.detailed).toBeLessThan(at(10).work.low.detailed);
    expect(many.work.high.detailed).toBeGreaterThan(at(10).work.high.detailed);
    expect(one.timeMs?.low ?? 0).toBeGreaterThan(60_000);
    expect((many.costUsd?.high ?? 0) / (one.costUsd?.high ?? 1)).toBeLessThan(5);
  });

  it("never plans more detailed work than there are candidates", () => {
    const work = plannedWork(300, 10, 40, 0.5);
    expect(work.detailed).toBeLessThanOrEqual(40 + Math.ceil(1.2 * 300));
    expect(work.screen).toBe(40);
  });

  it("says when a request would go over the job budget", () => {
    const tight = { ...profile(), budgetUsd: 0.05 };
    expect(estimateAnalysis(tight, { episodes: 50, requested: 10 }).overBudget).toBe("yes");
    expect(estimateAnalysis(profile(), { episodes: 4, textKb: 10, requested: 5 }).overBudget).toBe(
      "no",
    );
  });

  it("is unavailable, not invented, for a model that was never measured", () => {
    const unknown = workProfile(config(8), { PROMOLENS_EVALUATOR_MODEL: "example/unmeasured" });
    const e = estimateAnalysis(unknown, { episodes: 10, requested: 5 });
    expect(e.timeMs).toBeNull();
    expect(e.costUsd).toBeNull();
  });

  it("describes ranges plainly", () => {
    expect(describeDuration({ low: 250_000, high: 520_000 })).toBe("about 4 to 9 minutes");
    expect(describeDuration({ low: 10_000, high: 40_000 })).toBe("under a minute");
    expect(describeCost({ low: 0.031, high: 0.058 })).toBe("$0.031 to $0.058");
    expect(describeCost({ low: 0.3, high: 0.56 })).toBe("$0.30 to $0.56");
  });

  it("shows the demo the same defaults the deployment uses", () => {
    const deployed = workProfile({ limits: readLimits({}) as BackendConfig["limits"] }, {});
    expect(demoWorkProfile()).toEqual(deployed);
  });
});
