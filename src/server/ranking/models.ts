import type { Effort, Pricing } from "../inference/openrouter.ts";

/**
 * Default models for each ranking stage. Every one is swappable from the
 * command line, and every one goes through the same strict zero-data-
 * retention routing check before anything is sent.
 *
 * Checked on OpenRouter's public endpoint list on 2026-11-10:
 * - anthropic/claude-haiku-5.5 (the Phase 3 discovery model): Google Vertex
 *   endpoints, safety retention off, structured outputs.
 * - openai/gpt-6-luna: Azure endpoints, safety retention off, structured
 *   outputs, the same price as Haiku 5.5. A different model family from the
 *   discovery model, so its mistakes are less likely to repeat discovery's.
 *   That independence is an assumption, not something we measured.
 */

export const DEFAULT_SCREEN_MODEL = "anthropic/claude-haiku-5.5";
export const DEFAULT_EVALUATOR_MODEL = "openai/gpt-6-luna";

export type StageSettings = { maxTokens: number; reasoningEffort: Effort | null };

/** Output limits cover reasoning and the answer together. */
export const STAGE_SETTINGS = {
  screen: { maxTokens: 3_000, reasoningEffort: null },
  "cold-viewer": { maxTokens: 6_000, reasoningEffort: "low" },
  editorial: { maxTokens: 8_000, reasoningEffort: "low" },
  pairwise: { maxTokens: 5_000, reasoningEffort: "low" },
} as const satisfies Record<string, StageSettings>;

/** Highest per-token prices among eligible endpoints, for dry-run estimates only. */
export const RANKING_PRICE_SNAPSHOT: Record<string, Pricing & { checked: string }> = {
  "anthropic/claude-haiku-5.5": {
    inputPerToken: 0.11e-6,
    outputPerToken: 0.55e-6,
    checked: "2026-11-10",
  },
  "openai/gpt-6-luna": { inputPerToken: 0.11e-6, outputPerToken: 0.55e-6, checked: "2026-11-10" },
};
