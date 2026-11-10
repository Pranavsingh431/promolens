import { proposalJsonSchema, proposalResponseSchema } from "../../domain/discovery/proposal.ts";
import type { SpendGuard } from "../inference/limits.ts";
import { completeJson, type ModelConfig } from "../inference/openrouter.ts";
import type { Complete } from "./run.ts";

/** The real model call for discovery, shared by the command-line tool and the web backend. */
export function createDiscoveryComplete(
  config: ModelConfig,
  guard: SpendGuard,
  overrideSignal?: AbortSignal,
): Complete {
  return (prompt, signal) => {
    const active = overrideSignal ?? signal;
    return completeJson(
      {
        ...prompt,
        schemaName: "promo_proposals",
        jsonSchema: proposalJsonSchema,
        parse: (value) => proposalResponseSchema.parse(value),
      },
      config,
      { guard, ...(active ? { signal: active } : {}) },
    );
  };
}
