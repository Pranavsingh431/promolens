import type { EstimateStage, StageProfile, WorkProfile } from "./estimate.ts";

type Measured = {
  calls: number;
  p50Ms: number;
  p95Ms: number;
  /** Mean tokens per call. Output tokens already include reasoning tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Mean billed cost over the cost the token price predicts. */
  billedShare: number;
  retryShare: number;
};

export type TokenPrice = { inputPerToken: number; outputPerToken: number };

/**
 * Per-call measurements from real calls on 2026-11-10, read from the metadata
 * of 919 cached ranking judgments and 100 discovery reads on the supplied
 * 50-episode pack (private/analysis/profile-inference.py). No prompt or answer
 * text is involved. A model or stage missing here has no estimate.
 */
export const MEASURED: Record<string, Partial<Record<EstimateStage, Measured>>> = {
  "anthropic/claude-haiku-5.5": {
    discovery: {
      calls: 100,
      p50Ms: 10_400,
      p95Ms: 14_600,
      inputTokens: 6_384,
      outputTokens: 1_828,
      billedShare: 0.91,
      retryShare: 0.04,
    },
    screen: {
      calls: 278,
      p50Ms: 3_000,
      p95Ms: 3_900,
      inputTokens: 2_816,
      outputTokens: 345,
      billedShare: 0.91,
      retryShare: 0,
    },
    "cold-viewer": {
      calls: 34,
      p50Ms: 4_600,
      p95Ms: 5_700,
      inputTokens: 3_740,
      outputTokens: 747,
      billedShare: 0.91,
      retryShare: 0,
    },
    editorial: {
      calls: 34,
      p50Ms: 4_100,
      p95Ms: 11_100,
      inputTokens: 5_604,
      outputTokens: 712,
      billedShare: 0.91,
      retryShare: 0.06,
    },
  },
  "openai/gpt-6-luna": {
    "cold-viewer": {
      calls: 210,
      p50Ms: 6_100,
      p95Ms: 8_800,
      inputTokens: 1_935,
      outputTokens: 484,
      billedShare: 0.94,
      retryShare: 0.005,
    },
    editorial: {
      calls: 205,
      p50Ms: 6_400,
      p95Ms: 13_000,
      inputTokens: 2_713,
      outputTokens: 504,
      billedShare: 0.68,
      retryShare: 0,
    },
    pairwise: {
      calls: 152,
      p50Ms: 3_100,
      p95Ms: 8_000,
      inputTokens: 2_672,
      outputTokens: 202,
      billedShare: 1.06,
      retryShare: 0.026,
    },
  },
};

/** The models and prices the measurements were taken with. */
export const MEASURED_MODELS = {
  discovery: "anthropic/claude-haiku-5.5",
  screen: "anthropic/claude-haiku-5.5",
  evaluator: "openai/gpt-6-luna",
} as const;
export const MEASURED_PRICES: Record<string, TokenPrice> = {
  "anthropic/claude-haiku-5.5": { inputPerToken: 0.11e-6, outputPerToken: 0.55e-6 },
  "openai/gpt-6-luna": { inputPerToken: 0.11e-6, outputPerToken: 0.55e-6 },
};

/** The deployment defaults (see src/server/config.ts and DISCOVERY_BATCH), for pages with no backend. */
export const DEFAULT_LIMITS = {
  concurrency: 8,
  budgetUsd: 1.5,
  maxRequests: 6_000,
  stepBudgetMs: 200_000,
  discoveryBatch: 25,
};

function stageProfile(
  model: string,
  stage: EstimateStage,
  prices: Record<string, TokenPrice>,
): StageProfile | null {
  const measured = MEASURED[model]?.[stage];
  const price = prices[model];
  if (!measured || !price) return null;
  const tokenPrice =
    measured.inputTokens * price.inputPerToken + measured.outputTokens * price.outputPerToken;
  return {
    p50Ms: measured.p50Ms,
    p95Ms: measured.p95Ms,
    costLowUsd: tokenPrice * Math.min(1, measured.billedShare),
    costHighUsd: tokenPrice * Math.max(1.1, measured.billedShare * 1.1),
    retryShare: measured.retryShare,
  };
}

export function profileFor(
  models: { discovery: string; screen: string; evaluator: string },
  prices: Record<string, TokenPrice>,
  limits: typeof DEFAULT_LIMITS,
): WorkProfile {
  return {
    ...limits,
    stages: {
      discovery: stageProfile(models.discovery, "discovery", prices),
      screen: stageProfile(models.screen, "screen", prices),
      "cold-viewer": stageProfile(models.evaluator, "cold-viewer", prices),
      editorial: stageProfile(models.evaluator, "editorial", prices),
      pairwise: stageProfile(models.evaluator, "pairwise", prices),
    },
  };
}

/** What the public demo shows: the measured models at the default limits. */
export const demoWorkProfile = (): WorkProfile =>
  profileFor(MEASURED_MODELS, MEASURED_PRICES, DEFAULT_LIMITS);
