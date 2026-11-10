import {
  DISCOVERY_PROMPT_VERSION,
  buildDiscoveryPrompt,
  type ContextVariant,
} from "../../domain/discovery/prompts/discovery-v1.ts";
import {
  PROPOSAL_SCHEMA_VERSION,
  proposalJsonSchema,
  type ProposalResponse,
} from "../../domain/discovery/proposal.ts";
import {
  RESOLVE_CONFIG,
  resolveProposals,
  type ProposalOutcome,
} from "../../domain/discovery/resolve.ts";
import type { Candidate } from "../../domain/evaluation/candidate.ts";
import type { Episode, Show } from "../../domain/screenplay/schema.ts";
import type { Timeline } from "../../domain/screenplay/timeline.ts";
import { InferenceError, ZERO_USAGE, type Usage } from "../inference/errors.ts";
import { Semaphore } from "../inference/limits.ts";
import type { Effort, JsonCompletion } from "../inference/openrouter.ts";
import type { PrivacyMode } from "../inference/routing.ts";
import {
  cacheKey,
  contentHash,
  episodeFingerprint,
  fileDiscoveryCache,
  type CacheKeyParts,
  type DiscoveryCacheStore,
} from "./cache.ts";

/**
 * Runs AI candidate discovery over episodes: one model call per episode,
 * cached, with bounded concurrency. The model call is injected, so this runs
 * the same with OpenRouter, a test double, or (dry run) no model at all.
 *
 * An episode is "succeeded" or "cached" only when a validated response
 * exists. Failures keep their reason and are retried on the next run, because
 * nothing is written to the cache for them.
 */

export type DiscoveryConfig = {
  model: string;
  variant: ContextVariant;
  maxTokens: number;
  reasoningEffort: Effort | null;
  privacy: PrivacyMode;
};

export type Prompt = { system: string; user: string };
export type Complete = (
  prompt: Prompt,
  signal?: AbortSignal,
) => Promise<JsonCompletion<ProposalResponse>>;

export type EpisodeStatus = "succeeded" | "cached" | "failed" | "skipped" | "planned";

export type EpisodeRun = {
  episode: number;
  status: EpisodeStatus;
  cacheKey: string;
  promptChars: number;
  attempts: number;
  usage: Usage;
  billedUsd: number | null;
  estimatedUsd: number;
  latencyMs: number;
  provider: string | null;
  generationId: string | null;
  proposals: number;
  accepted: number;
  rejected: Record<string, number>;
  /** Distinct event numbers the model cited that do not exist. */
  unknownRefs: number;
  proposalsWithUnknownRefs: number;
  adjusted: number;
  cacheCorrupt: boolean;
  error?: { kind: string; message: string; status?: number };
};

export type EpisodeDetail = {
  episode: number;
  response: ProposalResponse | null;
  outcomes: ProposalOutcome[];
};

const FATAL = new Set(["auth", "payment", "config", "no-provider", "not-found", "invalid-request"]);

/** Everything that can change a model's answer for one episode. */
export function cacheKeyParts(
  episode: Episode,
  config: DiscoveryConfig,
  prompt: Prompt,
): CacheKeyParts {
  return {
    episodeFingerprint: episodeFingerprint(episode, config.variant),
    promptSha256: contentHash(prompt),
    jsonSchemaSha256: contentHash(proposalJsonSchema),
    promptVersion: DISCOVERY_PROMPT_VERSION,
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    variant: config.variant,
    model: config.model,
    maxTokens: config.maxTokens,
    reasoningEffort: config.reasoningEffort,
    privacy: config.privacy,
  };
}

export function methodFor(config: DiscoveryConfig) {
  return {
    method: `ai-${config.variant}`,
    methodVersion: `${DISCOVERY_PROMPT_VERSION}+${PROPOSAL_SCHEMA_VERSION}+${RESOLVE_CONFIG.version}|${config.model}|effort-${config.reasoningEffort ?? "default"}|max-${config.maxTokens}|${config.privacy}`,
  };
}

export async function runDiscovery(input: {
  show: Show;
  timeline: Timeline;
  episodes: number[];
  config: DiscoveryConfig;
  /** Where responses are kept: a directory, or any store when `cache` is given. */
  cacheDir?: string;
  cache?: DiscoveryCacheStore;
  dryRun: boolean;
  /** Ignore the cache completely. */
  fresh: boolean;
  /**
   * Ignore cache entries written before this time. Used when resuming a run
   * that was started with fresh, so it keeps its own results but does not
   * fall back to older ones it chose to ignore.
   */
  cacheNotBefore?: string;
  concurrency: number;
  complete?: Complete;
  estimateUsd?: (prompt: Prompt) => number;
  signal?: AbortSignal;
  onEpisode?: (run: EpisodeRun) => void;
}): Promise<{ runs: EpisodeRun[]; details: EpisodeDetail[]; candidates: Candidate[] }> {
  if (!input.dryRun && !input.complete)
    throw new Error("A model call is required unless this is a dry run.");
  if (!input.cache && input.cacheDir === undefined) {
    throw new Error("A discovery run needs cacheDir or cache.");
  }
  const cache = input.cache ?? fileDiscoveryCache(input.cacheDir as string);
  const { method, methodVersion } = methodFor(input.config);
  const semaphore = new Semaphore(input.concurrency);
  let fatal: InferenceError | undefined;

  const planned = [...new Set(input.episodes)]
    .sort((a, b) => a - b)
    .map((number) => {
      const episode = input.show.episodes.find((e) => e.number === number);
      if (!episode) throw new Error(`Episode ${number} is not in this show.`);
      const prompt = buildDiscoveryPrompt(episode, input.config.variant);
      return { number, episode, prompt, parts: cacheKeyParts(episode, input.config, prompt) };
    });
  // All lookups happen together and before any model call, so one round trip
  // covers a whole batch and model calls start in episode order.
  const reads = await Promise.all(
    planned.map(({ parts }) => (input.fresh ? ({ status: "miss" } as const) : cache.read(parts))),
  );
  const work = planned.map(({ number, episode, prompt, parts }, index) =>
    semaphore.run(async () => {
      const run: EpisodeRun = {
        episode: number,
        status: "skipped",
        cacheKey: cacheKey(parts),
        promptChars: prompt.system.length + prompt.user.length,
        attempts: 0,
        usage: ZERO_USAGE,
        billedUsd: null,
        estimatedUsd: 0,
        latencyMs: 0,
        provider: null,
        generationId: null,
        proposals: 0,
        accepted: 0,
        rejected: {},
        unknownRefs: 0,
        proposalsWithUnknownRefs: 0,
        adjusted: 0,
        cacheCorrupt: false,
      };

      let response: ProposalResponse | null = null;
      const read = reads[index] as Awaited<ReturnType<DiscoveryCacheStore["read"]>>;
      const cached =
        read.status === "hit" && input.cacheNotBefore && read.entry.createdAt < input.cacheNotBefore
          ? { status: "miss" as const }
          : read;
      if (cached.status === "hit") {
        response = cached.response;
        run.status = "cached";
        run.provider = cached.entry.meta.provider;
        run.generationId = cached.entry.meta.generationId;
      } else {
        run.cacheCorrupt = cached.status === "corrupt";
        const refusedBefore = input.dryRun ? null : await cache.readRefusal?.(parts);
        if (refusedBefore) {
          run.status = "failed";
          run.error = {
            kind: refusedBefore,
            message: "Refused in an earlier run. Not sent again.",
          };
        } else if (input.dryRun) {
          run.status = "planned";
          run.estimatedUsd = input.estimateUsd?.(prompt) ?? 0;
        } else if (fatal) {
          run.status = "skipped";
          run.error = {
            kind: "stopped",
            message: `Not attempted after a fatal error: ${fatal.kind}.`,
          };
        } else if (input.signal?.aborted) {
          run.status = "skipped";
          run.error = {
            kind: "aborted",
            message: "Run was cancelled before this episode started.",
          };
        } else {
          try {
            const result = await (input.complete as Complete)(prompt, input.signal);
            response = result.value;
            Object.assign(run, {
              status: "succeeded",
              attempts: result.spend.attempts,
              usage: result.spend.usage,
              billedUsd: result.spend.billedUsd,
              estimatedUsd: result.spend.estimatedUsd,
              latencyMs: result.latencyMs,
              provider: result.provider,
              generationId: result.generationId,
            });
            await cache.write({
              parts,
              createdAt: new Date().toISOString(),
              response: result.value,
              meta: {
                generationId: result.generationId,
                provider: result.provider,
                servedModel: result.servedModel,
                attempts: result.spend.attempts,
                latencyMs: result.latencyMs,
                billedUsd: result.spend.billedUsd,
                estimatedUsd: result.spend.estimatedUsd,
                usage: result.spend.usage,
              },
            });
          } catch (error) {
            const failure =
              error instanceof InferenceError
                ? error
                : new InferenceError("provider", "Unexpected failure.");
            const notStarted = failure.kind === "budget" || failure.kind === "request-limit";
            run.status = notStarted && !failure.spend?.attempts ? "skipped" : "failed";
            run.error = {
              kind: failure.kind,
              message: failure.message,
              ...(failure.status ? { status: failure.status } : {}),
            };
            if (failure.spend) {
              Object.assign(run, {
                attempts: failure.spend.attempts,
                usage: failure.spend.usage,
                billedUsd: failure.spend.billedUsd,
                estimatedUsd: failure.spend.estimatedUsd,
              });
            }
            if (failure.kind === "content-policy" || failure.kind === "refusal") {
              await cache.writeRefusal?.(parts, failure.kind);
            }
            if (FATAL.has(failure.kind)) fatal = failure;
          }
        }
      }

      let detail: EpisodeDetail = { episode: number, response: null, outcomes: [] };
      let candidates: Candidate[] = [];
      if (response) {
        const resolved = resolveProposals(response, episode, input.timeline, {
          method,
          methodVersion,
        });
        detail = { episode: number, response, outcomes: resolved.outcomes };
        candidates = resolved.candidates;
        run.proposals = response.proposals.length;
        run.accepted = resolved.candidates.length;
        for (const outcome of resolved.outcomes) {
          if (outcome.status === "rejected" && outcome.reason) {
            run.rejected[outcome.reason] = (run.rejected[outcome.reason] ?? 0) + 1;
          }
          if (outcome.unknownRefs.length) run.proposalsWithUnknownRefs += 1;
          if (outcome.status === "accepted" && outcome.adjustments.length) run.adjusted += 1;
        }
        run.unknownRefs = new Set(resolved.outcomes.flatMap((o) => o.unknownRefs)).size;
      }
      input.onEpisode?.(run);
      return { run, detail, candidates };
    }),
  );

  const results = await Promise.all(work);
  const candidates = results
    .flatMap((r) => r.candidates)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  return {
    runs: results.map((r) => r.run),
    details: results.map((r) => r.detail),
    candidates,
  };
}

export type RunTotals = {
  episodes: number;
  byStatus: Record<EpisodeStatus, number>;
  /** Episodes with a validated response, from this run or the cache. */
  processed: number;
  /** Processed episodes that produced at least one valid candidate. */
  withCandidates: number;
  proposals: number;
  accepted: number;
  rejected: Record<string, number>;
  unknownRefs: number;
  proposalsWithUnknownRefs: number;
  adjusted: number;
  attempts: number;
  usage: Usage;
  billedUsd: number | null;
  estimatedUsd: number;
  cacheHits: number;
  cacheCorrupt: number;
  latencyMsMedian: number | null;
};

export function summarizeRuns(runs: readonly EpisodeRun[]): RunTotals {
  const byStatus: Record<EpisodeStatus, number> = {
    succeeded: 0,
    cached: 0,
    failed: 0,
    skipped: 0,
    planned: 0,
  };
  const rejected: Record<string, number> = {};
  let usage = ZERO_USAGE;
  let billed: number | null = null;
  for (const run of runs) {
    byStatus[run.status] += 1;
    for (const [reason, count] of Object.entries(run.rejected))
      rejected[reason] = (rejected[reason] ?? 0) + count;
    usage = {
      inputTokens: usage.inputTokens + run.usage.inputTokens,
      outputTokens: usage.outputTokens + run.usage.outputTokens,
      reasoningTokens: usage.reasoningTokens + run.usage.reasoningTokens,
      cachedTokens: usage.cachedTokens + run.usage.cachedTokens,
    };
    if (run.billedUsd !== null) billed = (billed ?? 0) + run.billedUsd;
  }
  const latencies = runs
    .filter((r) => r.status === "succeeded")
    .map((r) => r.latencyMs)
    .sort((a, b) => a - b);
  const sum = (pick: (r: EpisodeRun) => number) => runs.reduce((n, r) => n + pick(r), 0);
  return {
    episodes: runs.length,
    byStatus,
    processed: byStatus.succeeded + byStatus.cached,
    withCandidates: runs.filter(
      (r) => (r.status === "succeeded" || r.status === "cached") && r.accepted > 0,
    ).length,
    proposals: sum((r) => r.proposals),
    accepted: sum((r) => r.accepted),
    rejected,
    unknownRefs: sum((r) => r.unknownRefs),
    proposalsWithUnknownRefs: sum((r) => r.proposalsWithUnknownRefs),
    adjusted: sum((r) => r.adjusted),
    attempts: sum((r) => r.attempts),
    usage,
    billedUsd: billed,
    estimatedUsd: sum((r) => r.estimatedUsd),
    cacheHits: byStatus.cached,
    cacheCorrupt: runs.filter((r) => r.cacheCorrupt).length,
    latencyMsMedian: latencies.length
      ? (latencies[Math.floor(latencies.length / 2)] ?? null)
      : null,
  };
}
