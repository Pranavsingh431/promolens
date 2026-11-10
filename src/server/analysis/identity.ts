import { createHash } from "node:crypto";

import {
  CONTEXT_VARIANTS,
  DISCOVERY_PROMPT_VERSION,
  type ContextVariant,
} from "../../domain/discovery/prompts/discovery-v1.ts";
import { MERGE_CONFIG } from "../../domain/discovery/merge.ts";
import { PROPOSAL_SCHEMA_VERSION } from "../../domain/discovery/proposal.ts";
import { RESOLVE_CONFIG } from "../../domain/discovery/resolve.ts";
import { RUBRIC_VERSION } from "../../domain/evaluation/rubric.ts";
import { DEFAULT_RANKING_CONFIG } from "../../domain/ranking/config.ts";
import { POOL_CONFIG } from "../../domain/ranking/pool.ts";
import { COLD_VIEWER_PROMPT_VERSION } from "../../domain/ranking/prompts/cold-viewer-v1.ts";
import { EDITORIAL_PROMPT_VERSION } from "../../domain/ranking/prompts/editorial-v1.ts";
import { PAIRWISE_PROMPT_VERSION } from "../../domain/ranking/prompts/pairwise-v1.ts";
import { SCREEN_PROMPT_VERSION } from "../../domain/ranking/prompts/screen-v1.ts";
import type { Show } from "../../domain/screenplay/schema.ts";
import { contentHash } from "../discovery/cache.ts";
import { DEFAULT_DISCOVERY_MODEL } from "../discovery/models.ts";
import type { DiscoveryConfig } from "../discovery/run.ts";
import { stageModel } from "../ranking/live.ts";
import {
  DEFAULT_EVALUATOR_MODEL,
  DEFAULT_SCREEN_MODEL,
  STAGE_SETTINGS,
} from "../ranking/models.ts";
import type { RankingModels } from "../ranking/run.ts";

/**
 * What makes two analyses "the same". Anything that can change an answer is in
 * here, so a new ranking version, prompt, or model starts a new analysis.
 */

type Env = Record<string, string | undefined>;

export function rankingModels(env: Env): RankingModels {
  const screener = env.PROMOLENS_SCREEN_MODEL ?? DEFAULT_SCREEN_MODEL;
  const evaluator = env.PROMOLENS_EVALUATOR_MODEL ?? DEFAULT_EVALUATOR_MODEL;
  return {
    screen: stageModel(screener, "screen"),
    "cold-viewer": stageModel(evaluator, "cold-viewer"),
    editorial: stageModel(evaluator, "editorial"),
    pairwise: stageModel(evaluator, "pairwise"),
    secondJudge: null,
  };
}

export function discoveryConfigs(env: Env): Record<ContextVariant, DiscoveryConfig> {
  const model = env.PROMOLENS_DISCOVERY_MODEL ?? DEFAULT_DISCOVERY_MODEL;
  const config = (variant: ContextVariant): DiscoveryConfig => ({
    model,
    variant,
    maxTokens: 12_000,
    reasoningEffort: "low",
    privacy: "strict-zdr",
  });
  return { "writer-context": config("writer-context"), "screen-only": config("screen-only") };
}

export function pipelineIdentity(env: Env) {
  const ranking = DEFAULT_RANKING_CONFIG;
  const parts = {
    ranking,
    pool: POOL_CONFIG,
    merge: MERGE_CONFIG,
    resolve: RESOLVE_CONFIG,
    rubric: RUBRIC_VERSION,
    prompts: {
      discovery: DISCOVERY_PROMPT_VERSION,
      proposal: PROPOSAL_SCHEMA_VERSION,
      screen: SCREEN_PROMPT_VERSION,
      cold: COLD_VIEWER_PROMPT_VERSION,
      editorial: EDITORIAL_PROMPT_VERSION,
      pairwise: PAIRWISE_PROMPT_VERSION,
    },
    models: rankingModels(env),
    discovery: discoveryConfigs(env),
    variants: CONTEXT_VARIANTS,
    stages: STAGE_SETTINGS,
  };
  return {
    version: `${ranking.version}-${contentHash(parts).slice(0, 12)}`,
    hash: contentHash(parts),
  };
}

/** Hash of what the screenplays say, ignoring how the ZIP happened to be packed. */
export function normalizedShowHash(show: Show): string {
  return contentHash(
    show.episodes.map(({ number, durationMs, writerNotes, scenes, events }) => ({
      number,
      durationMs,
      writerNotes,
      scenes,
      // Source line numbers change with formatting, not with what the script says.
      events: events.map((event) => ({ ...event, line: undefined, endLine: undefined })),
    })),
  );
}

export function analysisIdentity(ownerId: string, contentSha256: string, pipelineHash: string) {
  return createHash("sha256").update(`${ownerId}|${contentSha256}|${pipelineHash}`).digest("hex");
}
