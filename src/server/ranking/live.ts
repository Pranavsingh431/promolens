import { InferenceError } from "../inference/errors.ts";
import type { SpendGuard } from "../inference/limits.ts";
import { completeJson, type ModelConfig } from "../inference/openrouter.ts";
import type { RoutingPlan } from "../inference/routing.ts";
import { STAGE_SETTINGS } from "./models.ts";
import type { StageCall, StageModel, StageName } from "./run.ts";

/** Real model calls for ranking, shared by the command-line tool and the web backend. */

export function stageModel(model: string, stage: StageName): StageModel {
  const settings = STAGE_SETTINGS[stage];
  return {
    model,
    maxTokens: settings.maxTokens,
    reasoningEffort: settings.reasoningEffort,
    privacy: "strict-zdr",
  };
}

export function createStageCall(input: {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  attempts: number;
  routings: ReadonlyMap<string, RoutingPlan>;
  guard: SpendGuard;
  /** Used instead of the run's own signal, so a soft stop lets calls in flight finish. */
  signal?: AbortSignal;
}): StageCall {
  const configs = new Map<string, ModelConfig>();
  const configFor = (model: StageModel): ModelConfig => {
    const key = `${model.model}|${model.maxTokens}|${model.reasoningEffort}`;
    let found = configs.get(key);
    if (!found) {
      const plan = input.routings.get(model.model);
      if (!plan) throw new InferenceError("config", `No routing for ${model.model}.`);
      found = {
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: model.model,
        maxTokens: model.maxTokens,
        reasoningEffort: model.reasoningEffort,
        timeoutMs: input.timeoutMs,
        maxAttempts: input.attempts,
        provider: plan.provider,
        pricing: plan.pricing,
        tokenLimitParam: plan.tokenLimitParam,
      };
      configs.set(key, found);
    }
    return found;
  };
  return (_stage, model, request, hooks) => {
    const signal = input.signal ?? hooks.signal;
    return completeJson(request, configFor(model), {
      guard: input.guard,
      onAttemptError: hooks.onAttemptError,
      ...(signal ? { signal } : {}),
    });
  };
}
