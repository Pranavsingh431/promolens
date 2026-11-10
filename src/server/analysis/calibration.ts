import { profileFor } from "../../domain/calibration.ts";
import type { WorkProfile } from "../../domain/estimate.ts";
import { readLimits, type BackendConfig } from "../config.ts";
import { DEFAULT_DISCOVERY_MODEL, PRICE_SNAPSHOT } from "../discovery/models.ts";
import {
  DEFAULT_EVALUATOR_MODEL,
  DEFAULT_SCREEN_MODEL,
  RANKING_PRICE_SNAPSHOT,
} from "../ranking/models.ts";
import { DISCOVERY_BATCH } from "./orchestrate.ts";

export { MEASURED } from "../../domain/calibration.ts";

const PRICES = { ...PRICE_SNAPSHOT, ...RANKING_PRICE_SNAPSHOT };

/** The estimate inputs for this deployment's configured models, prices, and limits. */
export function workProfile(
  config: Pick<BackendConfig, "limits">,
  env: Record<string, string | undefined>,
): WorkProfile {
  const { limits } = config;
  return profileFor(
    {
      discovery: env.PROMOLENS_DISCOVERY_MODEL ?? DEFAULT_DISCOVERY_MODEL,
      screen: env.PROMOLENS_SCREEN_MODEL ?? DEFAULT_SCREEN_MODEL,
      evaluator: env.PROMOLENS_EVALUATOR_MODEL ?? DEFAULT_EVALUATOR_MODEL,
    },
    PRICES,
    {
      concurrency: limits.modelConcurrency,
      budgetUsd: limits.jobBudgetUsd,
      maxRequests: limits.jobMaxRequests,
      stepBudgetMs: limits.stepBudgetMs,
      discoveryBatch: DISCOVERY_BATCH,
    },
  );
}

/** The profile the home page shows before analysis. Null when a limit is set to an invalid value. */
export function pageWorkProfile(): WorkProfile | null {
  const limits = readLimits(process.env);
  return limits ? workProfile({ limits }, process.env) : null;
}
