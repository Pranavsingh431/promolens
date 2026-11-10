import type { Pricing } from "../inference/openrouter.ts";

/**
 * Default discovery model: Claude Haiku 5.5. On 2026-11-10 it was the
 * lowest-cost model we found with strict zero-data-retention endpoints that
 * support structured outputs (Google Vertex). Gemini 3.1 Flash Lite, the
 * first model considered, was only offered on endpoints with Google Safety
 * Retention, which is not strict zero data retention.
 */
export const DEFAULT_DISCOVERY_MODEL = "anthropic/claude-haiku-5.5";

/**
 * Highest per-token prices among each model's eligible endpoints, checked on
 * OpenRouter on 2026-11-10. Used only for dry-run estimates, which make no
 * network calls. Live runs read current prices before sending anything.
 */
export const PRICE_SNAPSHOT: Record<string, Pricing & { checked: string }> = {
  "anthropic/claude-haiku-5.5": {
    inputPerToken: 0.11e-6,
    outputPerToken: 0.55e-6,
    checked: "2026-11-10",
  },
  "openai/gpt-5-mini": { inputPerToken: 0.275e-6, outputPerToken: 2.2e-6, checked: "2026-11-10" },
  "google/gemini-3.1-flash-lite": {
    inputPerToken: 0.45e-6,
    outputPerToken: 2.7e-6,
    checked: "2026-11-10",
  },
};
