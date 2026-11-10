import { createHash } from "node:crypto";

import { eq, ne, and, sum } from "drizzle-orm";

import type { JobFacts, JobFailureCode, JobStage, JobState } from "../../domain/analysis-job.ts";
import { buildHybridSet } from "../../domain/discovery/merge.ts";
import type { ContextVariant } from "../../domain/discovery/prompts/discovery-v1.ts";
import { CONTEXT_VARIANTS } from "../../domain/discovery/prompts/discovery-v1.ts";
import { generateCueBased, generateUniform } from "../../domain/evaluation/baselines.ts";
import {
  candidateSetSchema,
  type Candidate,
  type CandidateSet,
} from "../../domain/evaluation/candidate.ts";
import { DEFAULT_RANKING_CONFIG } from "../../domain/ranking/config.ts";
import { promoExportSchema, rankingOutputSchema } from "../../domain/ranking/output.ts";
import { buildRankingPool, POOL_CONFIG } from "../../domain/ranking/pool.ts";
import { showSchema, type Show } from "../../domain/screenplay/schema.ts";
import { createTimeline } from "../../domain/screenplay/timeline.ts";
import type { BackendConfig } from "../config.ts";
import type { Database } from "../db/client.ts";
import { jobSpend } from "../db/schema.ts";
import { contentHash } from "../discovery/cache.ts";
import { createDiscoveryComplete } from "../discovery/live.ts";
import { methodFor, runDiscovery, summarizeRuns } from "../discovery/run.ts";
import { ingestScreenplayZip } from "../ingest/ingest.ts";
import { SpendGuard } from "../inference/limits.ts";
import { planRouting, type RoutingPlan } from "../inference/routing.ts";
import {
  activeJob,
  claimJob,
  failJob,
  getShowById,
  rollingSpend,
  spendSoFar,
  stageOf,
  transitionJob,
  updateFacts,
  type JobRow,
  type ShowRow,
} from "../jobs.ts";
import { logEvent } from "../log.ts";
import { createStageCall } from "../ranking/live.ts";
import { runRanking, type RankingRun, type StageStats } from "../ranking/run.ts";
import { jobPrefix, showPrefix, type ObjectStore } from "../storage.ts";
import { databaseDiscoveryCache, databaseStageCache } from "./cache-stores.ts";
import { discoveryConfigs, rankingModels } from "./identity.ts";
import {
  MAX_FAILURE_ROUNDS,
  type DiscoverOutcome,
  type PrepareOutcome,
  type RankOutcome,
  type StepOutcome,
} from "./orchestrate.ts";

/**
 * The steps of one analysis. Each is safe to run twice: it re-checks the job,
 * reuses cached judgments, and writes under deterministic keys. Steps pass only
 * ids between them; screenplay text stays in private storage.
 *
 * All the real work is the existing engine: ingestScreenplayZip, the baselines,
 * runDiscovery, buildHybridSet, buildRankingPool, and runRanking.
 */

export type PipelineDeps = {
  db: Database;
  storage: ObjectStore;
  config: BackendConfig;
  env: Record<string, string | undefined>;
};

const FATAL_KINDS = new Set([
  "auth",
  "payment",
  "config",
  "no-provider",
  "not-found",
  "invalid-request",
]);
const REFUSAL_KINDS = new Set(["content-policy", "refusal"]);
const BUDGET_KINDS = new Set(["budget", "request-limit"]);
/** Calls already running get this long to finish after a step stops starting new ones. */
const HARD_STOP_GRACE_MS = 45_000;
const CANCEL_CHECK_MS = 3_000;
const HEARTBEAT_MS = 5_000;
const PROGRESS_WRITE_MS = 2_000;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const STOP = { proceed: false } as const;

const STATE_ORDER: readonly JobState[] = [
  "queued",
  "validating",
  "parsing",
  "discovering",
  "evaluating",
  "ranking",
];

/** Moves forward, and does nothing if a retried step finds the job already past this point. */
async function advance(
  deps: PipelineDeps,
  job: JobRow,
  to: JobState,
  patch: Parameters<typeof transitionJob>[3] = {},
): Promise<JobRow> {
  if (STATE_ORDER.indexOf(job.state) >= STATE_ORDER.indexOf(to)) return job;
  const moved = await transitionJob(deps.db, job.id, to, patch);
  if (moved) logEvent("job.state", { jobId: job.id, attempt: job.attempt, state: to });
  return moved ?? job;
}

async function fail(
  deps: PipelineDeps,
  job: JobRow,
  code: JobFailureCode,
  stage: JobStage,
  retryable: boolean,
): Promise<typeof STOP> {
  await failJob(deps.db, job.id, code, stage, retryable);
  logEvent("job.failed", { jobId: job.id, attempt: job.attempt, stage, errorCategory: code });
  return STOP;
}

const parsedKey = (show: ShowRow) => `${showPrefix(show.ownerId, show.id)}parsed/show.json`;
export const episodeKey = (show: ShowRow, episode: number) =>
  `${showPrefix(show.ownerId, show.id)}parsed/episodes/${episode}.json`;
const attemptPrefix = (job: JobRow) => `${jobPrefix(job.ownerId, job.id)}${job.attempt}/`;

async function loadShow(deps: PipelineDeps, show: ShowRow): Promise<Show> {
  const bytes = await deps.storage.get(parsedKey(show));
  if (!bytes) throw new Error("Parsed show is missing.");
  return showSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

async function requireShow(deps: PipelineDeps, job: JobRow): Promise<ShowRow> {
  const show = await getShowById(deps.db, job.showId);
  if (!show) throw new Error("Show is missing.");
  return show;
}

type StepUsage = {
  billedUsd: number | null;
  estimatedUsd: number;
  live: number;
  cached: number;
  failed: number;
  refused: number;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Runs paid work against what the job has left to spend. While it runs, the
 * step's row holds spent plus reserved money, so a crash leaves an upper bound.
 */
async function withSpend<T>(
  deps: PipelineDeps,
  job: JobRow,
  stepKey: string,
  phase: "discovery" | "ranking",
  work: (guard: SpendGuard) => Promise<{ value: T; usage: StepUsage }>,
): Promise<T> {
  const { limits } = deps.config;
  const already = await deps.db
    .select({
      spent: sum(jobSpend.spentUsd).mapWith(Number),
      requests: sum(jobSpend.requests).mapWith(Number),
    })
    .from(jobSpend)
    .where(and(eq(jobSpend.jobId, job.id), ne(jobSpend.stepKey, stepKey)));
  // A job may spend what is left of its own cap and of the editor's rolling cap, whichever is less.
  const rolling = await rollingSpend(deps.db, job.ownerId, new Date());
  const guard = new SpendGuard({
    maxCostUsd: Math.max(
      0,
      Math.min(limits.jobBudgetUsd - (already[0]?.spent ?? 0), limits.rollingBudgetUsd - rolling),
    ),
    maxRequests: Math.max(0, limits.jobMaxRequests - (already[0]?.requests ?? 0)),
  });
  const record = async (values: Partial<typeof jobSpend.$inferInsert>) => {
    await deps.db
      .insert(jobSpend)
      .values({ jobId: job.id, stepKey, phase, ...values })
      .onConflictDoUpdate({
        target: [jobSpend.jobId, jobSpend.stepKey],
        set: { ...values, updatedAt: new Date() },
      });
  };
  await record({ status: "running" });
  const heartbeat = setInterval(() => {
    void record({ spentUsd: guard.spentUsd + guard.reservedUsd, requests: guard.requests }).catch(
      () => {},
    );
  }, HEARTBEAT_MS);
  try {
    const { value, usage } = await work(guard);
    clearInterval(heartbeat);
    await record({
      status: "finished",
      spentUsd: guard.spentUsd,
      requests: guard.requests,
      billedUsd: usage.billedUsd,
      estimatedUsd: usage.estimatedUsd,
      liveJudgments: usage.live,
      cachedJudgments: usage.cached,
      failedJudgments: usage.failed,
      refusedJudgments: usage.refused,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    logEvent("step.spend", {
      jobId: job.id,
      attempt: job.attempt,
      phase,
      requests: guard.requests,
      liveJudgments: usage.live,
      cachedJudgments: usage.cached,
      failedJudgments: usage.failed,
      refusedJudgments: usage.refused,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      billedUsd: usage.billedUsd,
      estimatedUsd: usage.estimatedUsd,
    });
    return value;
  } finally {
    clearInterval(heartbeat);
  }
}

/** Aborts when the job is cancelled or taken over, so paid calls stop within seconds. */
function watchForStop(deps: PipelineDeps, job: JobRow, runId: string, onStop: () => void) {
  const timer = setInterval(() => {
    void activeJob(deps.db, job.id, runId)
      .then((live) => {
        if (!live) onStop();
      })
      .catch(() => {});
  }, CANCEL_CHECK_MS);
  return () => clearInterval(timer);
}

async function routingFor(deps: PipelineDeps, models: readonly string[]) {
  const routings = new Map<string, RoutingPlan>();
  for (const model of new Set(models)) {
    // Strict zero data retention only. A model with no such endpoint stops the run.
    routings.set(
      model,
      await planRouting(model, "strict-zdr", { baseUrl: deps.config.openRouter.baseUrl }),
    );
  }
  return routings;
}

/** Validates the source again, parses it, and stores the parsed show for later steps. */
export async function prepare(
  deps: PipelineDeps,
  jobId: string,
  runId: string,
): Promise<PrepareOutcome> {
  const stop = { ...STOP, episodes: [], variants: [] };
  const claimed = await claimJob(deps.db, jobId, runId);
  if (!claimed) return stop;
  let job = await advance(deps, claimed, "validating", { startedAt: new Date() });
  const show = await requireShow(deps, job);

  const bytes = await deps.storage.get(show.storageKey);
  if (!bytes) {
    await fail(deps, job, "storage-unavailable", "validating", true);
    return stop;
  }
  if (sha256(bytes) !== show.archiveSha256) {
    await fail(deps, job, "invalid-archive", "validating", false);
    return stop;
  }

  job = await advance(deps, job, "parsing");
  const started = Date.now();
  const ingested = await ingestScreenplayZip(bytes, { archiveName: show.fileName });
  if (!ingested.ok) {
    await fail(deps, job, "unsupported-format", "parsing", false);
    return stop;
  }
  const { show: parsed } = ingested;
  await deps.storage.put(parsedKey(show), JSON.stringify(parsed), "application/json");
  await Promise.all(
    parsed.episodes.map((episode) =>
      deps.storage.put(
        episodeKey(show, episode.number),
        JSON.stringify(episode),
        "application/json",
      ),
    ),
  );
  const episodes = parsed.episodes.map((e) => e.number);
  await advance(deps, job, "discovering", {
    facts: {
      episodes: episodes.length,
      progress: { done: 0, total: episodes.length, unit: "episodes" },
    },
  });
  logEvent("job.parsed", {
    jobId,
    attempt: job.attempt,
    episodes: episodes.length,
    durationMs: Date.now() - started,
  });
  return { proceed: true, episodes, variants: [...CONTEXT_VARIANTS] };
}

export async function discoverBatch(
  deps: PipelineDeps,
  jobId: string,
  runId: string,
  stepKey: string,
  variant: string,
  episodes: number[],
  readsDone: number,
): Promise<DiscoverOutcome> {
  const stop = { ...STOP, failedEpisodes: [] };
  const job = await activeJob(deps.db, jobId, runId);
  if (!job) return stop;
  const show = await requireShow(deps, job);
  const parsed = await loadShow(deps, show);
  const timeline = createTimeline(parsed);
  const config = discoveryConfigs(deps.env)[variant as ContextVariant];
  const { limits, openRouter } = deps.config;
  const routing = (await routingFor(deps, [config.model])).get(config.model) as RoutingPlan;

  const hardStop = new AbortController();
  const unwatch = watchForStop(deps, job, runId, () => hardStop.abort());
  // Anything still unanswered at the limit counts as failed and is tried again on a later pass.
  const limitTimer = setTimeout(() => hardStop.abort(), limits.stepBudgetMs + HARD_STOP_GRACE_MS);
  try {
    const runs = await withSpend(deps, job, stepKey, "discovery", async (guard) => {
      const result = await runDiscovery({
        show: parsed,
        timeline,
        episodes,
        config,
        cache: databaseDiscoveryCache(deps.db, { ownerId: job.ownerId, showId: job.showId }),
        dryRun: false,
        fresh: false,
        concurrency: limits.modelConcurrency,
        complete: createDiscoveryComplete(
          {
            baseUrl: openRouter.baseUrl,
            apiKey: openRouter.apiKey,
            model: config.model,
            maxTokens: config.maxTokens,
            reasoningEffort: config.reasoningEffort,
            timeoutMs: limits.modelTimeoutMs,
            maxAttempts: limits.modelAttempts,
            provider: routing.provider,
            pricing: routing.pricing,
            tokenLimitParam: routing.tokenLimitParam,
          },
          guard,
          hardStop.signal,
        ),
        signal: hardStop.signal,
      });
      const totals = summarizeRuns(result.runs);
      return {
        value: result.runs,
        usage: {
          billedUsd: totals.billedUsd,
          estimatedUsd: totals.estimatedUsd,
          live: totals.byStatus.succeeded,
          cached: totals.byStatus.cached,
          failed: totals.byStatus.failed,
          refused: result.runs.filter((r) => REFUSAL_KINDS.has(r.error?.kind ?? "")).length,
          inputTokens: totals.usage.inputTokens,
          outputTokens: totals.usage.outputTokens,
        },
      };
    });

    const kinds = runs.flatMap((r) => (r.error ? [r.error.kind] : []));
    if (kinds.some((kind) => FATAL_KINDS.has(kind))) {
      await fail(deps, job, "provider-unavailable", "discovering", true);
      return stop;
    }
    if (kinds.some((kind) => BUDGET_KINDS.has(kind))) {
      await fail(deps, job, "budget-reached", "discovering", false);
      return stop;
    }
    const total = (job.facts.episodes ?? episodes.length) * CONTEXT_VARIANTS.length;
    const done =
      readsDone + runs.filter((r) => r.status === "succeeded" || r.status === "cached").length;
    await updateFacts(deps.db, jobId, runId, {
      ...job.facts,
      progress: {
        done: Math.floor(Math.min(done, total) / CONTEXT_VARIANTS.length),
        total: job.facts.episodes ?? episodes.length,
        unit: "episodes",
      },
    });
    // Refusals are final. Anything else that failed may work on a later pass.
    return {
      proceed: true,
      failedEpisodes: runs
        .filter(
          (r) =>
            (r.status === "failed" || r.status === "skipped") &&
            !REFUSAL_KINDS.has(r.error?.kind ?? ""),
        )
        .map((r) => r.episode),
    };
  } finally {
    clearTimeout(limitTimer);
    unwatch();
  }
}

type PoolArtifact = {
  candidates: Candidate[];
  stats: ReturnType<typeof buildRankingPool>["stats"];
  /** Episode reads with no model answer. Any gap makes the result partial. */
  gaps: number;
};

const poolKey = (job: JobRow) => `${attemptPrefix(job)}pool.json`;

/** Rebuilds candidates from cached answers, then builds the same pool the command line builds. */
export async function buildPool(
  deps: PipelineDeps,
  jobId: string,
  runId: string,
): Promise<StepOutcome> {
  const job = await activeJob(deps.db, jobId, runId);
  if (!job) return STOP;
  const show = await requireShow(deps, job);
  const parsed = await loadShow(deps, show);
  const timeline = createTimeline(parsed);
  const packSha256 = show.archiveSha256;
  const episodes = parsed.episodes.map((e) => e.number);
  const cache = databaseDiscoveryCache(deps.db, { ownerId: job.ownerId, showId: job.showId });

  const uniform = candidateSetSchema.parse({ ...generateUniform(timeline), packSha256 });
  const cues = candidateSetSchema.parse({ ...generateCueBased(timeline), packSha256 });
  let gaps = 0;
  const aiSets: CandidateSet[] = [];
  for (const [variant, config] of Object.entries(discoveryConfigs(deps.env))) {
    // A dry run makes no model calls. It reads only what is cached.
    const result = await runDiscovery({
      show: parsed,
      timeline,
      episodes,
      config,
      cache,
      dryRun: true,
      fresh: false,
      concurrency: 8,
    });
    gaps += result.runs.filter((r) => r.status === "planned").length;
    const { method, methodVersion } = methodFor(config);
    aiSets.push(
      candidateSetSchema.parse({
        method,
        methodVersion,
        packSha256,
        candidates: result.candidates,
        rejected: {},
        proposals: result.candidates.length,
      }),
    );
    logEvent("job.discovered", { jobId, phase: variant, moments: result.candidates.length });
  }
  const { set: hybrid } = buildHybridSet([uniform, cues, ...aiSets], timeline, packSha256);
  const pool = buildRankingPool(hybrid, uniform);
  const artifact: PoolArtifact = { candidates: pool.candidates, stats: pool.stats, gaps };
  await deps.storage.put(poolKey(job), JSON.stringify(artifact), "application/json");
  await advance(deps, job, "evaluating", {
    facts: { ...job.facts, moments: pool.candidates.length, progress: undefined },
  });
  return { proceed: true };
}

function usageOf(stats: readonly StageStats[]): StepUsage {
  const billed = stats.flatMap((s) => (s.billedUsd === null ? [] : [s.billedUsd]));
  const sum = (pick: (s: StageStats) => number) => stats.reduce((n, s) => n + pick(s), 0);
  return {
    billedUsd: billed.length ? billed.reduce((a, b) => a + b, 0) : null,
    estimatedUsd: sum((s) => s.estimatedUsd),
    live: sum((s) => s.live),
    cached: sum((s) => s.cached),
    failed: sum((s) => s.failed),
    refused: sum((s) => s.refused),
    inputTokens: sum((s) => s.usage.inputTokens),
    outputTokens: sum((s) => s.usage.outputTokens),
  };
}

function createProgress(deps: PipelineDeps, job: JobRow, runId: string) {
  let last = 0;
  let queue: Promise<void> = Promise.resolve();
  return {
    report(facts: JobFacts) {
      const now = Date.now();
      if (now - last < PROGRESS_WRITE_MS) return;
      last = now;
      queue = queue.then(() => updateFacts(deps.db, job.id, runId, facts)).catch(() => {});
    },
    drain: () => queue,
  };
}

const DONE: RankOutcome = { next: "done" };

/**
 * One time-boxed pass of the ranking engine. runRanking resumes from cached
 * judgments, so a pass that runs out of time has lost nothing: the next pass
 * starts where this one stopped. The final pass writes the results.
 */
export async function rankSlice(
  deps: PipelineDeps,
  jobId: string,
  runId: string,
  stepKey: string,
  failureRounds: number,
): Promise<RankOutcome> {
  const job = await activeJob(deps.db, jobId, runId);
  if (!job) return DONE;
  const show = await requireShow(deps, job);
  const parsed = await loadShow(deps, show);
  const poolBytes = await deps.storage.get(poolKey(job));
  if (!poolBytes) throw new Error("Candidate pool is missing.");
  const pool = JSON.parse(new TextDecoder().decode(poolBytes)) as PoolArtifact;

  const config = DEFAULT_RANKING_CONFIG;
  const models = rankingModels(deps.env);
  const { limits, openRouter } = deps.config;
  const routings = await routingFor(deps, [models.screen.model, models.editorial.model]);

  const softStop = new AbortController();
  const hardStop = new AbortController();
  let stopped = false;
  const softTimer = setTimeout(() => softStop.abort(), limits.stepBudgetMs);
  const hardTimer = setTimeout(() => hardStop.abort(), limits.stepBudgetMs + HARD_STOP_GRACE_MS);
  const unwatch = watchForStop(deps, job, runId, () => {
    stopped = true;
    softStop.abort();
    hardStop.abort();
  });

  const progress = createProgress(deps, job, runId);
  let assessed = 0;
  let compared = 0;
  let current = job;
  let rankingStarted = false;

  try {
    const run: RankingRun = await withSpend(deps, job, stepKey, "ranking", async (guard) => {
      const result = await runRanking({
        timeline: createTimeline(parsed),
        packSha256: show.archiveSha256,
        pool: pool.candidates,
        episodes: parsed.episodes.map((e) => e.number),
        scopeLabel: "all",
        config,
        configHash: contentHash(config).slice(0, 12),
        models,
        cache: databaseStageCache(deps.db, { ownerId: job.ownerId, showId: job.showId }),
        call: createStageCall({
          baseUrl: openRouter.baseUrl,
          apiKey: openRouter.apiKey,
          timeoutMs: limits.modelTimeoutMs,
          attempts: limits.modelAttempts,
          routings,
          guard,
          signal: hardStop.signal,
        }),
        replicates: 1,
        concurrency: limits.modelConcurrency,
        runId: job.id,
        now: () => job.createdAt,
        signal: softStop.signal,
        onJudgment: (stage, status) => {
          if (status !== "live" && status !== "cached") return;
          if (stage === "editorial") {
            assessed += 1;
            progress.report({
              ...job.facts,
              progress: { done: assessed, unit: "moments" },
            });
          }
          if (stage === "pairwise") {
            compared += 1;
            if (!rankingStarted) {
              rankingStarted = true;
              void advance(deps, current, "ranking").then((moved) => {
                current = moved;
              });
            }
            progress.report({
              ...job.facts,
              progress: { done: compared, unit: "comparisons" },
            });
          }
        },
      });
      return { value: result, usage: usageOf(result.stats) };
    });
    await progress.drain();
    if (stopped) return DONE;

    const output = run.output;
    if (!output || !run.promos) throw new Error("Ranking returned no output.");

    if (output.status === "complete") {
      await finalize(deps, job, run, pool, routings, config.version);
      return DONE;
    }
    if (run.fatal) {
      await fail(deps, job, "provider-unavailable", stageOf(current.state), true);
      return DONE;
    }
    if (softStop.signal.aborted) return { next: "continue" };

    const hitLimit = run.stats.some((s) =>
      Object.keys(s.failures).some((kind) => BUDGET_KINDS.has(kind)),
    );
    if (!hitLimit && failureRounds < MAX_FAILURE_ROUNDS) return { next: "wait" };

    if (output.shortlist.length > 0) {
      await finalize(deps, job, run, pool, routings, config.version);
    } else {
      await fail(
        deps,
        job,
        hitLimit ? "budget-reached" : "model-output-invalid",
        stageOf(current.state),
        !hitLimit,
      );
    }
    return DONE;
  } finally {
    clearTimeout(softTimer);
    clearTimeout(hardTimer);
    unwatch();
  }
}

/**
 * Writes the results, then flips the job in one transaction. Keys include the
 * attempt, so a retry can never overwrite an earlier attempt's finished results.
 */
async function finalize(
  deps: PipelineDeps,
  job: JobRow,
  run: RankingRun,
  pool: PoolArtifact,
  routings: ReadonlyMap<string, RoutingPlan>,
  rankingVersion: string,
): Promise<void> {
  const gaps = pool.gaps;
  const output = rankingOutputSchema.parse(
    gaps > 0
      ? {
          ...run.output,
          status: "partial",
          notes: [
            `${gaps} episode reading(s) got no model answer, so this show was only partly searched.`,
            ...(run.output?.notes ?? []),
          ],
        }
      : run.output,
  );
  const promos = promoExportSchema.parse({ ...run.promos, status: output.status });

  const prefix = attemptPrefix(job);
  const keys = {
    rankingKey: `${prefix}ranking.json`,
    promosKey: `${prefix}promos.json`,
    manifestKey: `${prefix}manifest.json`,
  };
  const totals = await spendSoFar(deps.db, job.id);
  const manifest = {
    jobId: job.id,
    attempt: job.attempt,
    rankingVersion,
    pipelineVersion: job.pipelineVersion,
    pool: { version: POOL_CONFIG.version, ...pool.stats, gaps },
    routing: Object.fromEntries(routings),
    models: output.versions.models,
    totals,
    stages: run.stats.map((stage) => ({ ...stage, latenciesMs: undefined })),
    positionBias: output.positionBias,
    counts: output.counts,
  };
  await deps.storage.put(keys.rankingKey, JSON.stringify(output), "application/json");
  await deps.storage.put(keys.promosKey, JSON.stringify(promos), "application/json");
  await deps.storage.put(keys.manifestKey, JSON.stringify(manifest), "application/json");

  const outcome = output.status === "complete" ? "completed" : "partial";
  const facts: JobFacts = { episodes: job.facts.episodes, moments: job.facts.moments };
  await transitionJob(
    deps.db,
    job.id,
    outcome,
    { ...keys, facts, finishedAt: new Date() },
    outcome,
  );
  logEvent("job.finished", {
    jobId: job.id,
    attempt: job.attempt,
    outcome,
    requests: totals.requests,
    liveJudgments: totals.liveJudgments,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    billedUsd: totals.billedUsd,
    estimatedUsd: totals.estimatedUsd,
  });
}

/** The last resort when a step has used up its retries. */
export async function failUnexpected(
  deps: PipelineDeps,
  jobId: string,
  runId: string,
): Promise<void> {
  const job = await activeJob(deps.db, jobId, runId);
  if (job) await fail(deps, job, "interrupted", stageOf(job.state), true);
}
