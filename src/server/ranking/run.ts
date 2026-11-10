import { CONFLICT_WORDS, PHYSICAL_ACTION } from "../../domain/evaluation/baselines.ts";
import type { Candidate } from "../../domain/evaluation/candidate.ts";
import { CRITERIA, RUBRIC_VERSION, type CriterionId } from "../../domain/evaluation/rubric.ts";
import {
  chooseFinalists,
  compareScored,
  composeOrder,
  diversityItem,
  emptyAssessment,
  narrativeDocument,
  scoreAssessment,
  type Assessment,
} from "../../domain/ranking/assemble.ts";
import { assertValidConfig, type RankingConfig } from "../../domain/ranking/config.ts";
import { proposeCorrection } from "../../domain/ranking/corrections.ts";
import { selectDiverse } from "../../domain/ranking/diversity.ts";
import { narrativeVectors } from "../../domain/ranking/narrative.ts";
import {
  PROMO_EXPORT_FORMAT,
  RANKING_OUTPUT_FORMAT,
  buildRecommendation,
  listEntry,
  promoExportSchema,
  rankingOutputSchema,
  type PromoExport,
  type RankingOutput,
  type Recommendation,
} from "../../domain/ranking/output.ts";
import {
  bradleyTerry,
  judgmentsScheduled,
  kendallTau,
  orderByStrength,
  pairStats,
  schedulePairs,
  type PairJudgment,
  type PairStats,
  type Strength,
} from "../../domain/ranking/pairwise.ts";
import {
  COLD_VIEWER_PROMPT_VERSION,
  buildColdViewerPrompt,
  coldViewerJsonSchema,
  coldViewerResponseSchema,
  type ColdViewerResponse,
} from "../../domain/ranking/prompts/cold-viewer-v1.ts";
import {
  EDITORIAL_PROMPT_VERSION,
  buildEditorialPrompt,
  editorialJsonSchema,
  editorialResponseSchema,
  type EditorialResponse,
} from "../../domain/ranking/prompts/editorial-v1.ts";
import {
  PAIRWISE_PROMPT_VERSION,
  buildPairwisePrompt,
  pairwiseJsonSchema,
  pairwiseResponseSchema,
  type PairwiseResponse,
} from "../../domain/ranking/prompts/pairwise-v1.ts";
import {
  MOMENT_TYPES,
  SCREEN_PROMPT_VERSION,
  buildScreenPrompt,
  screenJsonSchema,
  screenResponseSchema,
  type ScreenResponse,
} from "../../domain/ranking/prompts/screen-v1.ts";
import {
  screenDeterministic,
  screenPriority,
  selectForAssessment,
  type ScreenEntry,
} from "../../domain/ranking/screening.ts";
import { clipContext, clipFingerprintSource } from "../../domain/ranking/windows.ts";
import type { Timeline } from "../../domain/screenplay/timeline.ts";
import { contentHash } from "../discovery/cache.ts";
import { InferenceError, ZERO_USAGE, addUsage, type Usage } from "../inference/errors.ts";
import { Semaphore } from "../inference/limits.ts";
import type { Effort, JsonCompletion } from "../inference/openrouter.ts";
import type { PrivacyMode } from "../inference/routing.ts";
import {
  fileStageCache,
  type StageCacheStore,
  type StageKeyParts,
  type StoredRefusal,
} from "./cache.ts";

/**
 * Runs the Phase 4 ranking pipeline. Model calls are injected, so the same
 * code runs against OpenRouter, a test double, or nothing at all (a plan).
 *
 * A judgment counts only when a validated answer exists, from this run or
 * the cache. A failed judgment is recorded as failed and never replaced by a
 * default score. Re-running with the same settings sends only what is still
 * missing, so an interrupted run resumes from the cache.
 */

export const STAGES = ["screen", "cold-viewer", "editorial", "pairwise"] as const;
export type StageName = (typeof STAGES)[number];

export type StageModel = {
  model: string;
  maxTokens: number;
  reasoningEffort: Effort | null;
  privacy: PrivacyMode;
};

export type RankingModels = Record<StageName, StageModel> & {
  /** Optional second evaluator, used only to measure model disagreement. */
  secondJudge: { "cold-viewer": StageModel; editorial: StageModel } | null;
};

export type JsonSpec = {
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: object;
  parse: (value: unknown) => unknown;
};

export type StageCall = (
  stage: StageName,
  model: StageModel,
  request: JsonSpec,
  hooks: { signal?: AbortSignal; onAttemptError: (error: InferenceError, attempt: number) => void },
) => Promise<JsonCompletion<unknown>>;

export type StageStats = {
  stage: StageName;
  model: string;
  requested: number;
  live: number;
  cached: number;
  failed: number;
  skipped: number;
  planned: number;
  /** Requests the provider declined, in this run or recorded from an earlier one. */
  refused: number;
  attempts: number;
  /** Failed attempts by kind, including ones a retry recovered from. */
  attemptErrors: Record<string, number>;
  /**
   * Failed attempts by message. Messages come from our own code and name at
   * most a field path and a check, never prompt or completion text.
   */
  attemptMessages: Record<string, number>;
  /** Judgments that failed for good, by kind. */
  failures: Record<string, number>;
  cacheCorrupt: number;
  usage: Usage;
  billedUsd: number | null;
  estimatedUsd: number;
  latenciesMs: number[];
  wallMs: number;
};

type Judged<T> =
  | { status: "live" | "cached"; value: T }
  | { status: "failed" | "skipped"; error: { kind: string; message: string } }
  | { status: "planned" };

const FATAL = new Set(["auth", "payment", "config", "no-provider", "not-found", "invalid-request"]);
/**
 * Failures a re-run cannot fix: the provider or model declined this input.
 * They are final outcomes, listed for manual review, never given a score.
 */
const REFUSALS = new Set<string>(["content-policy", "refusal"]);
const isRefusal = (error: string | null) =>
  error !== null &&
  [...REFUSALS].some((kind) => error.endsWith(`:${kind}`) || error.endsWith(`-${kind}`));
const refusalKind = (error: string | null) =>
  error?.replace(/^.*[-:](?=content-policy|refusal)/, "") ?? "";
const PROMPT_VERSIONS: Record<StageName, string> = {
  screen: SCREEN_PROMPT_VERSION,
  "cold-viewer": COLD_VIEWER_PROMPT_VERSION,
  editorial: EDITORIAL_PROMPT_VERSION,
  pairwise: PAIRWISE_PROMPT_VERSION,
};

export type RankingInput = {
  timeline: Timeline;
  packSha256: string;
  pool: readonly Candidate[];
  episodes: readonly number[];
  scopeLabel: string;
  config: RankingConfig;
  configHash: string;
  models: RankingModels;
  /** Where judgments are kept: a directory, or any store when `cache` is given. */
  cacheDir?: string;
  cache?: StageCacheStore;
  /** Told as each judgment settles, so a caller can report progress. */
  onJudgment?: (stage: StageName, status: "live" | "cached" | "failed" | "skipped") => void;
  /** Told how much work is planned, as soon as it is known and whenever it grows. */
  onPlan?: (plan: RankingPlan) => void;
  /** Null makes a plan: cache lookups only, nothing is sent. */
  call: StageCall | null;
  /** Send requests again even though the provider refused them before. Off by default. */
  retryRefused?: boolean;
  replicates: number;
  concurrency: number;
  runId: string;
  now?: () => Date;
  signal?: AbortSignal;
  log?: (line: string) => void;
};

export type ReplicateRecord = {
  candidateId: string;
  replicate: number;
  judge: "primary" | "second";
  cold: ColdViewerResponse | null;
  editorial: EditorialResponse | null;
};

export type Agreement = {
  candidates: number;
  exact: Record<CriterionId, number | null>;
  meanAbsDiff: Record<CriterionId, number | null>;
  gateAgreement: number | null;
  scoreTau: number | null;
  meanAbsScoreDiff: number | null;
};

export type RankingRun = {
  output: RankingOutput | null;
  /** Every promo that passed the gates, with full detail. Null for a plan. */
  promos: PromoExport | null;
  assessments: Map<string, Assessment>;
  stats: StageStats[];
  replicates: ReplicateRecord[];
  pairs: Array<
    PairJudgment & { reason: string; margin: string; criteria: PairwiseResponse["criteria"] }
  >;
  strengths: Map<string, Strength>;
  stability: {
    replicate: Agreement | null;
    secondJudge: Agreement | null;
    pairwise: PairStats;
    /** Kendall tau between the finalists' individual-score order and their pairwise order. */
    pairwiseVsScoreTau: number | null;
  };
  audit: ScreeningAudit;
  plan: { screenCalls: number; passing: number } | null;
  fatal: { kind: string; message: string } | null;
};

export type ScreeningAudit = {
  passing: number;
  selected: Record<string, number>;
  excluded: number;
  momentTypes: Record<string, { pool: number; selected: number; excluded: number }>;
  keywordShare: { selected: number | null; excluded: number | null };
  exploration: {
    assessed: number;
    eligible: number;
    reachedFinalistScore: number;
    bestScore: number | null;
  };
};

function emptyStats(stage: StageName, model: string): StageStats {
  return {
    stage,
    model,
    requested: 0,
    live: 0,
    cached: 0,
    failed: 0,
    skipped: 0,
    planned: 0,
    refused: 0,
    attempts: 0,
    attemptErrors: {},
    attemptMessages: {},
    failures: {},
    cacheCorrupt: 0,
    usage: ZERO_USAGE,
    billedUsd: null,
    estimatedUsd: 0,
    latenciesMs: [],
    wallMs: 0,
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Clip or dialogue text with obvious keywords: "?" or "!" endings, conflict words, physical action. */
function hasObviousKeywords(a: Assessment): boolean {
  return a.stageA.view.events.some(
    (e) =>
      (e.kind === "dialogue" && /[?!]["'”’]*$/.test(e.text)) ||
      CONFLICT_WORDS.test(e.text) ||
      PHYSICAL_ACTION.test(e.text),
  );
}

/** Planned work, in judgments. Detailed assessments are clips, each needing two judgments. */
export type RankingPlan = { screen: number; detailed: number; comparisons: number | null };

/** rank-4 keeps assessing in batches until this many distinct clips pass. Absent in rank-3. */
function progressiveTarget(config: RankingConfig): { want: number; minBatch: number } | null {
  const planned = config as RankingConfig & {
    requested?: number;
    progressive?: { minBatch: number };
  };
  return planned.progressive && planned.requested
    ? { want: planned.requested, minBatch: planned.progressive.minBatch }
    : null;
}

export async function runRanking(input: RankingInput): Promise<RankingRun> {
  assertValidConfig(input.config);
  const { timeline, config, models } = input;
  if (!input.cache && input.cacheDir === undefined) {
    throw new Error("A ranking run needs cacheDir or cache.");
  }
  const cache = input.cache ?? fileStageCache(input.cacheDir as string);
  const log = input.log ?? (() => {});
  const semaphore = new Semaphore(input.concurrency);
  const stats = new Map<string, StageStats>();
  // Held in an object so the type checker sees updates made inside callbacks.
  const halt: { fatal: { kind: string; message: string } | null } = { fatal: null };

  const statsFor = (stage: StageName, model: string) => {
    const key = `${stage}|${model}`;
    let entry = stats.get(key);
    if (!entry) {
      entry = emptyStats(stage, model);
      stats.set(key, entry);
    }
    return entry;
  };

  async function judge<T>(
    stage: StageName,
    model: StageModel,
    prompt: { system: string; user: string },
    subjectSha256: string,
    replicate: number,
    spec: { schemaName: string; jsonSchema: object; parse: (value: unknown) => T },
  ): Promise<Judged<T>> {
    const result = await judgeOnce(stage, model, prompt, subjectSha256, replicate, spec);
    if (result.status !== "planned") input.onJudgment?.(stage, result.status);
    return result;
  }

  async function judgeOnce<T>(
    stage: StageName,
    model: StageModel,
    prompt: { system: string; user: string },
    subjectSha256: string,
    replicate: number,
    spec: { schemaName: string; jsonSchema: object; parse: (value: unknown) => T },
  ): Promise<Judged<T>> {
    const s = statsFor(stage, model.model);
    s.requested += 1;
    const parts: StageKeyParts = {
      stage,
      promptVersion: PROMPT_VERSIONS[stage],
      rubricVersion: RUBRIC_VERSION,
      subjectSha256,
      promptSha256: contentHash(prompt),
      jsonSchemaSha256: contentHash(spec.jsonSchema),
      model: model.model,
      maxTokens: model.maxTokens,
      reasoningEffort: model.reasoningEffort,
      privacy: model.privacy,
      replicate,
    };
    const cached = await cache.read(parts, spec.parse);
    if (cached.status === "hit") {
      s.cached += 1;
      return { status: "cached", value: cached.response };
    }
    if (cached.status === "corrupt") s.cacheCorrupt += 1;
    if (!input.retryRefused) {
      const stored = await cache.readRefusal(parts);
      if (stored) {
        s.refused += 1;
        s.failures[stored.kind] = (s.failures[stored.kind] ?? 0) + 1;
        return {
          status: "failed",
          error: { kind: stored.kind, message: "Refused in an earlier run. Not sent again." },
        };
      }
    }
    if (!input.call) {
      s.planned += 1;
      return { status: "planned" };
    }
    if (halt.fatal || input.signal?.aborted) {
      s.skipped += 1;
      return {
        status: "skipped",
        error: halt.fatal
          ? { kind: "stopped", message: `Not attempted after a fatal error: ${halt.fatal.kind}.` }
          : { kind: "aborted", message: "Run was cancelled." },
      };
    }
    const call = input.call;
    return semaphore.run(async () => {
      if (halt.fatal || input.signal?.aborted) {
        s.skipped += 1;
        return {
          status: "skipped" as const,
          error: { kind: halt.fatal ? "stopped" : "aborted", message: "Not attempted." },
        };
      }
      try {
        const result = await call(
          stage,
          model,
          { ...prompt, ...spec },
          {
            ...(input.signal ? { signal: input.signal } : {}),
            onAttemptError: (error) => {
              s.attemptErrors[error.kind] = (s.attemptErrors[error.kind] ?? 0) + 1;
              const message = error.message.slice(0, 160);
              if (message in s.attemptMessages || Object.keys(s.attemptMessages).length < 20) {
                s.attemptMessages[message] = (s.attemptMessages[message] ?? 0) + 1;
              }
            },
          },
        );
        s.live += 1;
        s.attempts += result.spend.attempts;
        s.usage = addUsage(s.usage, result.spend.usage);
        if (result.spend.billedUsd !== null)
          s.billedUsd = (s.billedUsd ?? 0) + result.spend.billedUsd;
        s.estimatedUsd += result.spend.estimatedUsd;
        s.latenciesMs.push(result.latencyMs);
        await cache.write(parts, result.value, {
          generationId: result.generationId,
          provider: result.provider,
          servedModel: result.servedModel,
          attempts: result.spend.attempts,
          latencyMs: result.latencyMs,
          billedUsd: result.spend.billedUsd,
          estimatedUsd: result.spend.estimatedUsd,
          usage: result.spend.usage,
        });
        return { status: "live" as const, value: result.value as T };
      } catch (error) {
        const failure =
          error instanceof InferenceError
            ? error
            : new InferenceError("provider", "Unexpected failure.");
        const notStarted =
          (failure.kind === "budget" || failure.kind === "request-limit") &&
          !failure.spend?.attempts;
        if (failure.spend) {
          s.attempts += failure.spend.attempts;
          s.usage = addUsage(s.usage, failure.spend.usage);
          if (failure.spend.billedUsd !== null) {
            s.billedUsd = (s.billedUsd ?? 0) + failure.spend.billedUsd;
          }
          s.estimatedUsd += failure.spend.estimatedUsd;
        }
        if (notStarted) s.skipped += 1;
        else s.failed += 1;
        s.failures[failure.kind] = (s.failures[failure.kind] ?? 0) + 1;
        if (REFUSALS.has(failure.kind)) {
          s.refused += 1;
          // Losing this record only means the request is sent once more next run.
          await cache
            .writeRefusal(parts, failure.kind as StoredRefusal["kind"])
            .catch(() => log(`Could not record a ${failure.kind} refusal for ${stage}.`));
        }
        if (FATAL.has(failure.kind) && !halt.fatal) {
          halt.fatal = { kind: failure.kind, message: failure.message };
          log(`Stopping: ${failure.kind}: ${failure.message}`);
        }
        return {
          status: notStarted ? ("skipped" as const) : ("failed" as const),
          error: { kind: failure.kind, message: failure.message },
        };
      }
    });
  }

  const timed = async <T>(stage: StageName, model: string, work: () => Promise<T>) => {
    const started = Date.now();
    const result = await work();
    statsFor(stage, model).wallMs += Date.now() - started;
    return result;
  };

  // Stage A: deterministic screening of every candidate in scope.
  const inScope = new Set(input.episodes);
  const scoped = input.pool.filter((c) => c.segments.every((s) => inScope.has(s.episode)));
  const stageA = screenDeterministic(scoped, timeline, config);
  const assessments = new Map<string, Assessment>();
  scoped.forEach((candidate, i) => {
    assessments.set(candidate.id, emptyAssessment(candidate, stageA[i] as (typeof stageA)[number]));
  });
  const passing = [...assessments.values()].filter((a) => a.stageA.pass);
  log(
    `Stage A: ${scoped.length} candidates in scope, ${passing.length} pass, ${scoped.length - passing.length} removed.`,
  );

  const subjectOf = (a: Assessment) =>
    contentHash(clipFingerprintSource(a.candidate.segments, a.stageA.view));

  // Stage B: quick first read, then selection for detailed assessment.
  await timed("screen", models.screen.model, () =>
    Promise.all(
      passing.map(async (a) => {
        const result = await judge<ScreenResponse>(
          "screen",
          models.screen,
          buildScreenPrompt(a.stageA.view),
          subjectOf(a),
          0,
          {
            schemaName: "promo_screen",
            jsonSchema: screenJsonSchema,
            parse: (v) => screenResponseSchema.parse(v),
          },
        );
        if ("value" in result) {
          a.screen = result.value;
          a.screenStatus = "ok";
          a.priority = screenPriority(result.value, a.stageA.cuts, config.weights);
        } else if (result.status === "planned") {
          a.screenStatus = "not-run";
        } else {
          a.screenStatus = result.status === "failed" ? "failed" : "skipped";
          a.screenError = `screen-${result.error.kind}`;
        }
      }),
    ),
  );

  const emptyAudit: ScreeningAudit = {
    passing: passing.length,
    selected: {},
    excluded: 0,
    momentTypes: {},
    keywordShare: { selected: null, excluded: null },
    exploration: { assessed: 0, eligible: 0, reachedFinalistScore: 0, bestScore: null },
  };
  if (!input.call) {
    return {
      output: null,
      promos: null,
      assessments,
      stats: [...stats.values()],
      replicates: [],
      pairs: [],
      strengths: new Map(),
      stability: {
        replicate: null,
        secondJudge: null,
        pairwise: pairStats([]),
        pairwiseVsScoreTau: null,
      },
      audit: emptyAudit,
      plan: {
        screenCalls: [...stats.values()].reduce((n, s) => n + s.planned, 0),
        passing: passing.length,
      },
      fatal: halt.fatal,
    };
  }

  const entries: ScreenEntry[] = passing.map((a) => ({
    candidateId: a.candidate.id,
    clipKey: a.candidate.clipKey,
    episode: a.candidate.segments[0]?.episode ?? 0,
    priority: a.priority,
    momentType: a.screen?.momentType ?? null,
  }));
  const selection = selectForAssessment(entries, config.screening);
  for (const chosen of selection.selected) {
    const a = assessments.get(chosen.candidateId);
    if (a) a.selection = chosen.reason;
  }
  const selectedCounts: Record<string, number> = {};
  for (const s of selection.selected)
    selectedCounts[s.reason] = (selectedCounts[s.reason] ?? 0) + 1;
  log(
    `Stage B: ${selection.selected.length} selected for detailed assessment (${Object.entries(
      selectedCounts,
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}), ${selection.excluded.length} left out.`,
  );

  // Stages C and D: cold viewer and editorial, independently, per clip.
  const replicates: ReplicateRecord[] = [];
  async function assess(a: Assessment): Promise<void> {
    const view = a.stageA.view;
    const context = clipContext(timeline, a.candidate.segments, config.windows);
    const subject = subjectOf(a);
    const coldSpec = {
      schemaName: "cold_viewer",
      jsonSchema: coldViewerJsonSchema,
      parse: (v: unknown) => coldViewerResponseSchema.parse(v),
    };
    const editorialSpec = {
      schemaName: "editorial_judgment",
      jsonSchema: editorialJsonSchema,
      parse: (v: unknown) => editorialResponseSchema.parse(v),
    };
    const coldPrompt = buildColdViewerPrompt(view);
    const editorialPrompt = buildEditorialPrompt(view, context);
    const runs: Array<Promise<void>> = [];
    const replicateCount = a.selection === "correction" ? 1 : input.replicates;
    for (let r = 0; r < replicateCount; r++) {
      const record: ReplicateRecord = {
        candidateId: a.candidate.id,
        replicate: r,
        judge: "primary",
        cold: null,
        editorial: null,
      };
      replicates.push(record);
      runs.push(
        (async () => {
          const [cold, editorial] = await Promise.all([
            judge<ColdViewerResponse>(
              "cold-viewer",
              models["cold-viewer"],
              coldPrompt,
              subject,
              r,
              coldSpec,
            ),
            judge<EditorialResponse>(
              "editorial",
              models.editorial,
              editorialPrompt,
              subject,
              r,
              editorialSpec,
            ),
          ]);
          if (cold.status === "live" || cold.status === "cached") record.cold = cold.value;
          if (editorial.status === "live" || editorial.status === "cached")
            record.editorial = editorial.value;
          if (r === 0) {
            a.cold = record.cold;
            a.editorial = record.editorial;
            const failed = [cold, editorial].find(
              (j) => j.status === "failed" || j.status === "skipped",
            );
            a.deepStatus =
              record.cold && record.editorial
                ? "ok"
                : failed?.status === "skipped"
                  ? "skipped"
                  : failed && "error" in failed && REFUSALS.has(failed.error.kind)
                    ? "refused"
                    : "failed";
            if (failed && "error" in failed) a.deepError = `${failed.status}:${failed.error.kind}`;
          }
        })(),
      );
    }
    const second = models.secondJudge;
    if (second && a.selection !== "correction") {
      const record: ReplicateRecord = {
        candidateId: a.candidate.id,
        replicate: 0,
        judge: "second",
        cold: null,
        editorial: null,
      };
      replicates.push(record);
      runs.push(
        (async () => {
          const [cold, editorial] = await Promise.all([
            judge<ColdViewerResponse>(
              "cold-viewer",
              second["cold-viewer"],
              coldPrompt,
              subject,
              0,
              coldSpec,
            ),
            judge<EditorialResponse>(
              "editorial",
              second.editorial,
              editorialPrompt,
              subject,
              0,
              editorialSpec,
            ),
          ]);
          if (cold.status === "live" || cold.status === "cached") record.cold = cold.value;
          if (editorial.status === "live" || editorial.status === "cached")
            record.editorial = editorial.value;
        })(),
      );
    }
    await Promise.all(runs);
    assessments.set(a.candidate.id, scoreAssessment(a, config));
  }

  const toAssess = [...assessments.values()].filter((a) => a.selection !== null);
  input.onPlan?.({ screen: passing.length, detailed: toAssess.length, comparisons: null });
  await timed("editorial", models.editorial.model, () => Promise.all(toAssess.map(assess)));
  log(
    `Stages C and D: ${toAssess.filter((a) => assessments.get(a.candidate.id)?.scored).length} of ${toAssess.length} fully assessed.`,
  );

  // rank-4: assess more clips, in screening order, until enough distinct ones pass the gates.
  // The quick screen already read every clip, so this only decides how deep the detailed reads go.
  const target = progressiveTarget(config);
  let topUpRounds = 0;
  let topUpUnfinished = false;
  if (target) {
    const pending = selection.excluded
      .map((e) => assessments.get(e.candidateId))
      .filter((a): a is Assessment => a !== undefined);
    const distinctEligible = () => {
      const eligibleNow = [...assessments.values()]
        .filter((a) => a.scored?.gate.pass)
        .sort(compareScored);
      const vectors = narrativeVectors(eligibleNow.map((a) => narrativeDocument(a, timeline)));
      return selectDiverse(
        eligibleNow.map((a) => diversityItem(a, timeline, vectors.get(a.candidate.id))),
        { ...config.diversity, top: target.want },
      ).selected.length;
    };
    let cursor = 0;
    while (cursor < pending.length && !halt.fatal) {
      const have = distinctEligible();
      if (have >= target.want) break;
      if (input.signal?.aborted) {
        topUpUnfinished = true;
        break;
      }
      const assessedSoFar = [...assessments.values()].filter((a) => a.scored).length;
      // Expect future clips to pass about as often as the ones assessed so far did.
      const yieldSoFar = Math.max(0.2, have / Math.max(1, assessedSoFar));
      const size = Math.min(
        pending.length - cursor,
        Math.max(target.minBatch, Math.ceil((target.want - have) / yieldSoFar)),
      );
      const batch = pending.slice(cursor, cursor + size);
      cursor += size;
      for (const a of batch) a.selection = "priority";
      toAssess.push(...batch);
      topUpRounds += 1;
      input.onPlan?.({ screen: passing.length, detailed: toAssess.length, comparisons: null });
      await timed("editorial", models.editorial.model, () => Promise.all(batch.map(assess)));
      log(`Top-up ${topUpRounds}: ${batch.length} more clips assessed.`);
    }
  }

  // Boundary corrections: checked by code, then judged again from scratch.
  const ranked = () => [...assessments.values()].filter((a) => a.scored).sort(compareScored);
  const keys = new Set([...assessments.values()].map((a) => a.candidate.clipKey));
  const derived: Assessment[] = [];
  for (const [index, a] of ranked().entries()) {
    if (!a.editorial?.correction.propose || a.derived) continue;
    if (index >= config.corrections.considerTop) {
      a.correction = {
        status: "not-considered",
        reason: "below the correction cut-off",
        derivedId: null,
      };
      continue;
    }
    if (derived.length >= config.corrections.maxPerRun) {
      a.correction = {
        status: "not-considered",
        reason: "correction limit reached",
        derivedId: null,
      };
      continue;
    }
    const context = clipContext(timeline, a.candidate.segments, config.windows);
    const result = proposeCorrection(
      a.candidate,
      a.editorial.correction,
      a.stageA.view,
      context,
      timeline,
    );
    if (!result.ok) {
      a.correction = { status: "invalid", reason: result.reason, derivedId: null };
      continue;
    }
    if (keys.has(result.candidate.clipKey)) {
      const existing = [...assessments.values()].find(
        (x) => x.candidate.clipKey === result.candidate.clipKey,
      );
      a.correction = {
        status: "valid",
        reason: "the corrected clip is already in the pool",
        derivedId: existing?.candidate.id ?? null,
      };
      continue;
    }
    const [checked] = screenDeterministic([result.candidate], timeline, config);
    if (!checked?.pass) {
      a.correction = {
        status: "invalid",
        reason: `stage-a:${checked?.reasons.join(",")}`,
        derivedId: null,
      };
      continue;
    }
    keys.add(result.candidate.clipKey);
    const next: Assessment = {
      ...emptyAssessment(result.candidate, checked),
      selection: "correction",
      derived: {
        from: a.candidate.id,
        startRef: result.startRef,
        endRef: result.endRef,
        reason: a.editorial.correction.reason,
      },
    };
    a.correction = {
      status: "valid",
      reason: a.editorial.correction.reason,
      derivedId: result.candidate.id,
    };
    assessments.set(next.candidate.id, next);
    derived.push(next);
  }
  if (derived.length) {
    await timed("editorial", models.editorial.model, () => Promise.all(derived.map(assess)));
  }
  log(`Corrections: ${derived.length} new clip(s) checked and judged again.`);

  // Stage E: head-to-head comparison of distinct finalists.
  const eligible = ranked().filter((a) => a.scored?.gate.pass);
  const { finalists, skipped } = chooseFinalists(eligible, timeline, config.pairwise);
  const finalistItems = finalists.map((a) => ({
    id: a.candidate.id,
    clipKey: a.candidate.clipKey,
    score: a.scored?.score ?? 0,
  }));
  const schedule = schedulePairs(finalistItems, config.pairwise);
  input.onPlan?.({
    screen: passing.length,
    detailed: toAssess.length + derived.length,
    comparisons: schedule.length,
  });
  const pairs: RankingRun["pairs"] = [];
  let pairFailures = 0;
  const pairRefusals: Array<{
    pairId: string;
    first: string;
    second: string;
    replicate: number;
  }> = [];
  await timed("pairwise", models.pairwise.model, () =>
    Promise.all(
      schedule.map(async (pair) => {
        const first = assessments.get(pair.first);
        const second = assessments.get(pair.second);
        if (!first || !second) return;
        const result = await judge<PairwiseResponse>(
          "pairwise",
          models.pairwise,
          buildPairwisePrompt(first.stageA.view, second.stageA.view),
          contentHash({ a: subjectOf(first), b: subjectOf(second) }),
          pair.replicate,
          {
            schemaName: "pairwise_judgment",
            jsonSchema: pairwiseJsonSchema,
            parse: (v) => pairwiseResponseSchema.parse(v),
          },
        );
        if (result.status === "live" || result.status === "cached") {
          pairs.push({
            ...pair,
            winner: result.value.winner,
            reason: result.value.reason,
            margin: result.value.margin,
            criteria: result.value.criteria,
          });
        } else if ("error" in result && REFUSALS.has(result.error.kind)) {
          pairRefusals.push({
            pairId: pair.pairId,
            first: pair.first,
            second: pair.second,
            replicate: pair.replicate,
          });
        } else {
          pairFailures += 1;
        }
      }),
    ),
  );
  pairs.sort((x, y) =>
    x.pairId < y.pairId ? -1 : x.pairId > y.pairId ? 1 : x.replicate - y.replicate,
  );
  const strengths = bradleyTerry(
    finalistItems.map((f) => f.id),
    pairs,
    { prior: config.pairwise.prior, scheduled: judgmentsScheduled(schedule) },
  );
  const finalistOrder = orderByStrength(finalistItems, strengths).map((f) => f.id);
  log(
    `Stage E: ${finalists.length} finalists, ${pairs.length} of ${schedule.length} comparisons judged.`,
  );

  // Stage F and G: final order, diversity, validated recommendations.
  const order = composeOrder([...assessments.values()], finalistOrder);
  const scoreRank = new Map(eligible.map((a, i) => [a.candidate.id, i + 1]));
  const validationFailures: string[] = [];
  const positions = new Map(order.map((entry, i) => [entry.assessment.candidate.id, i + 1]));
  const refusedPerClip = new Map<string, number>();
  for (const pair of pairRefusals) {
    for (const id of [pair.first, pair.second]) {
      refusedPerClip.set(id, (refusedPerClip.get(id) ?? 0) + 1);
    }
  }
  const recommend = (
    a: Assessment,
    rank: number,
    diversity: { maxSimilarity: number; nearest: string | null },
  ) =>
    buildRecommendation({
      rank,
      assessment: a,
      listPosition: positions.get(a.candidate.id) ?? 1,
      scoreRank: scoreRank.get(a.candidate.id) ?? 1,
      strength: strengths.get(a.candidate.id) ?? null,
      diversity,
      refusedComparisons: refusedPerClip.get(a.candidate.id) ?? 0,
      gateMinimum: config.gateMinimum,
    });
  const validated = new Map<string, Recommendation>();
  for (const entry of order) {
    if (entry.status !== "finalist" && entry.status !== "eligible") continue;
    const id = entry.assessment.candidate.id;
    try {
      validated.set(
        id,
        recommend(entry.assessment, validated.size + 1, { maxSimilarity: 0, nearest: null }),
      );
    } catch {
      validationFailures.push(id);
    }
  }
  const shortlistPool = order.filter((entry) => validated.has(entry.assessment.candidate.id));
  const vectors = narrativeVectors(
    shortlistPool.map((entry) => narrativeDocument(entry.assessment, timeline)),
  );
  const diverse = selectDiverse(
    shortlistPool.map((entry) =>
      diversityItem(entry.assessment, timeline, vectors.get(entry.assessment.candidate.id)),
    ),
    config.diversity,
  );
  const shortlist: Recommendation[] = diverse.selected.map((pick, i) =>
    recommend(assessments.get(pick.id) as Assessment, i + 1, {
      maxSimilarity: pick.maxSimilarity,
      nearest: pick.nearest,
    }),
  );

  const unjudged = [...assessments.values()].filter((a) => a.selection !== null && !a.scored);
  const refused = unjudged.filter((a) => a.deepStatus === "refused");
  const failedDeep = unjudged.filter((a) => a.deepStatus !== "refused");
  const deepFailures = failedDeep.length;
  const screenUnread = passing.filter(
    (a) => a.screenStatus === "failed" || a.screenStatus === "skipped",
  );
  const screenRefused = screenUnread.filter((a) => isRefusal(a.screenError));
  const screenFailures = screenUnread.length - screenRefused.length;
  // A clip whose quick read was refused can still be judged in detail. Only unjudged ones are missing.
  const screenRefusedOnly = screenRefused.filter((a) => !a.scored && a.deepStatus !== "refused");
  // Complete means nothing a re-run could still fill is missing. Refusals are final and listed.
  const complete =
    !halt.fatal &&
    !topUpUnfinished &&
    deepFailures === 0 &&
    pairFailures === 0 &&
    screenFailures === 0;
  const notes: string[] = [];
  if (!complete) {
    notes.push(
      `Partial run: ${screenFailures} quick reads, ${deepFailures} detailed assessments, and ${pairFailures} comparisons failed or were not attempted. Clips without a judgment are ranked below every judged clip and never get a default score. Re-run with the same settings to fill the gaps from the cache.`,
    );
  }
  if (refused.length || screenRefusedOnly.length || pairRefusals.length) {
    const ids = [...refused, ...screenRefusedOnly].map((a) => a.candidate.id);
    notes.push(
      `The model provider declined ${ids.length} clip(s) (${ids.join(", ")}) and ${pairRefusals.length} comparison(s). These clips were not judged, are ranked below every judged clip, and need a manual look: the filter may have removed some of the most intense moments.`,
    );
  }
  if (halt.fatal) notes.push(`The run stopped early: ${halt.fatal.kind}.`);
  if (target && shortlist.length < target.want) {
    notes.push(
      `${target.want} promos were requested and ${shortlist.length} distinct clips passed every essential gate and the final checks, so ${shortlist.length} are recommended. No clip below the gates was added to make up the number.`,
    );
  } else if (shortlist.length < config.diversity.top) {
    notes.push(`Only ${shortlist.length} clips passed every essential gate and the final checks.`);
  }
  if (target && finalists.length < shortlist.length) {
    notes.push(
      `The top ${finalists.length} eligible clips were compared head to head. The rest are ordered by their individual scores.`,
    );
  }
  if (validationFailures.length) {
    notes.push(
      `${validationFailures.length} eligible clip(s) failed final validation and were left out.`,
    );
  }
  if (skipped.length) {
    notes.push(
      `${skipped.length} eligible clip(s) were not compared head to head because they repeat a stronger finalist.`,
    );
  }
  const positionBias = pairStats(pairs);
  if (positionBias.firstShownWinShare !== null) {
    notes.push(
      `Head-to-head position check: the clip shown first won ${pct(positionBias.firstShownWinShare)} of ${positionBias.judgments - positionBias.ties} decided comparisons. ${positionBias.reversed} of ${positionBias.repeatedPairs} pairs judged in both orders changed winner with the order.`,
    );
  }
  notes.push(
    "No human labels were used. Scores and comparisons are model judgments checked by code, not audience measurements.",
  );

  const list = order.map((entry, i) => listEntry(i + 1, entry.status, entry.assessment));
  const counts: Record<string, number> = {
    poolInScope: scoped.length,
    stageAPassed: passing.length,
    stageARemoved: scoped.length - passing.length,
    screened: passing.filter((a) => a.screenStatus === "ok").length,
    screenFailed: screenFailures,
    selectedForAssessment: toAssess.length,
    excludedByScreening: passing.filter((a) => a.selection === null).length,
    assessed: [...assessments.values()].filter((a) => a.scored).length,
    assessmentFailed: deepFailures,
    refusedByProvider: refused.length + screenRefusedOnly.length,
    comparisonsRefused: pairRefusals.length,
    eligible: eligible.length,
    belowGate: [...assessments.values()].filter((a) => a.scored && !a.scored.gate.pass).length,
    correctionsProposed: [...assessments.values()].filter(
      (a) => a.editorial?.correction.propose && !a.derived,
    ).length,
    correctionsJudged: derived.length,
    finalists: finalists.length,
    comparisonsScheduled: schedule.length,
    comparisonsJudged: pairs.length,
    shortlist: shortlist.length,
    alternates: diverse.alternates.length,
    ...(target ? { requested: target.want, topUpRounds } : {}),
  };

  const output = rankingOutputSchema.parse({
    format: RANKING_OUTPUT_FORMAT,
    runId: input.runId,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    packSha256: input.packSha256,
    status: complete ? "complete" : "partial",
    scope: { label: input.scopeLabel, episodes: [...input.episodes].sort((x, y) => x - y) },
    versions: {
      ranking: config.version,
      configHash: input.configHash,
      rubric: RUBRIC_VERSION,
      prompts: { ...PROMPT_VERSIONS },
      models: {
        screen: models.screen.model,
        "cold-viewer": models["cold-viewer"].model,
        editorial: models.editorial.model,
        pairwise: models.pairwise.model,
        ...(models.secondJudge ? { "second-judge": models.secondJudge.editorial.model } : {}),
      },
    },
    config,
    counts,
    shortlist,
    alternates: diverse.alternates.map((alt) => ({
      candidateId: alt.id,
      listPosition: positions.get(alt.id) ?? alt.listPosition,
      redundantWith: alt.redundantWith,
      similarity: alt.similarity.value,
      basis: alt.similarity.basis,
    })),
    list,
    incomplete: {
      refusedClips: [
        ...refused.map((a) => ({
          candidateId: a.candidate.id,
          clipKey: a.candidate.clipKey,
          stage: "detailed" as const,
          kind: refusalKind(a.deepError),
        })),
        ...screenRefusedOnly.map((a) => ({
          candidateId: a.candidate.id,
          clipKey: a.candidate.clipKey,
          stage: "screen" as const,
          kind: refusalKind(a.screenError),
        })),
      ],
      refusedComparisons: pairRefusals,
      failedClips: failedDeep.map((a) => a.candidate.id),
    },
    positionBias,
    notes,
  });

  const shortlistRanks = new Map(shortlist.map((rec) => [rec.candidateId, rec.rank]));
  const alternateOf = new Map(diverse.alternates.map((alt) => [alt.id, alt.redundantWith]));
  const promos = promoExportSchema.parse({
    format: PROMO_EXPORT_FORMAT,
    runId: input.runId,
    createdAt: output.createdAt,
    packSha256: input.packSha256,
    rankingVersion: config.version,
    configHash: input.configHash,
    status: output.status,
    note: "Every clip that passed the essential gates, in ranked order, with its evidence. Scores are model judgments checked by code. They are not audience measurements, and no human has rated these clips unless the evaluation report says so.",
    promos: [...validated.values()].map((promo) => ({
      shortlistRank: shortlistRanks.get(promo.candidateId) ?? null,
      alternateOf: alternateOf.get(promo.candidateId) ?? null,
      promo,
    })),
  });

  // Stability and disagreement, from the judgments already made.
  const primary = (id: string, r: number) =>
    replicates.find((x) => x.candidateId === id && x.replicate === r && x.judge === "primary");
  const secondOf = (id: string) =>
    replicates.find((x) => x.candidateId === id && x.judge === "second");
  const replicateAgreement = agreement(
    [...assessments.values()],
    (a) => primary(a.candidate.id, 1),
    config,
  );
  const secondAgreement = models.secondJudge
    ? agreement([...assessments.values()], (a) => secondOf(a.candidate.id), config)
    : null;
  const finalistScoreOrder = [...finalistItems]
    .sort((x, y) => y.score - x.score || (x.clipKey < y.clipKey ? -1 : 1))
    .map((f) => f.id);

  // What screening left out.
  const finalistFloor = Math.min(...finalists.map((f) => f.scored?.score ?? 100), 100);
  const explored = [...assessments.values()].filter((a) => a.selection === "exploration");
  const momentTypes: ScreeningAudit["momentTypes"] = {};
  for (const type of MOMENT_TYPES) momentTypes[type] = { pool: 0, selected: 0, excluded: 0 };
  const excludedIds = new Set(
    selection.excluded
      .map((e) => e.candidateId)
      .filter((id) => assessments.get(id)?.selection === null),
  );
  for (const a of passing) {
    const type = a.screen?.momentType;
    if (!type) continue;
    const row = momentTypes[type] as { pool: number; selected: number; excluded: number };
    row.pool += 1;
    if (excludedIds.has(a.candidate.id)) row.excluded += 1;
    else row.selected += 1;
  }
  const share = (items: Assessment[]) =>
    items.length ? items.filter(hasObviousKeywords).length / items.length : null;
  const audit: ScreeningAudit = {
    passing: passing.length,
    selected: selectedCounts,
    excluded: excludedIds.size,
    momentTypes,
    keywordShare: {
      selected: share(passing.filter((a) => !excludedIds.has(a.candidate.id))),
      excluded: share(passing.filter((a) => excludedIds.has(a.candidate.id))),
    },
    exploration: {
      assessed: explored.filter((a) => a.scored).length,
      eligible: explored.filter((a) => a.scored?.gate.pass).length,
      reachedFinalistScore: finalists.length
        ? explored.filter((a) => a.scored?.gate.pass && (a.scored?.score ?? 0) >= finalistFloor)
            .length
        : 0,
      bestScore: explored.reduce<number | null>(
        (best, a) => (a.scored ? Math.max(best ?? 0, a.scored.score) : best),
        null,
      ),
    },
  };

  return {
    output,
    promos,
    assessments,
    stats: [...stats.values()],
    replicates,
    pairs,
    strengths,
    stability: {
      replicate: replicateAgreement,
      secondJudge: secondAgreement,
      pairwise: positionBias,
      pairwiseVsScoreTau: kendallTau(finalistScoreOrder, finalistOrder),
    },
    audit,
    plan: null,
    fatal: halt.fatal,
  };
}

/**
 * Agreement between each clip's primary judgment and another judgment of the
 * same clip (a repeat, or a second model), after the same checks and caps.
 */
function agreement(
  assessments: readonly Assessment[],
  other: (a: Assessment) => ReplicateRecord | undefined,
  config: RankingConfig,
): Agreement | null {
  const pairs: Array<{ id: string; a: Assessment; b: Assessment }> = [];
  for (const a of assessments) {
    if (!a.scored) continue;
    const record = other(a);
    if (!record?.cold || !record.editorial) continue;
    const b = scoreAssessment(
      { ...a, cold: record.cold, editorial: record.editorial, scored: null },
      config,
    );
    if (b.scored) pairs.push({ id: a.candidate.id, a, b });
  }
  if (!pairs.length) return null;
  const exact = {} as Agreement["exact"];
  const meanAbsDiff = {} as Agreement["meanAbsDiff"];
  for (const c of CRITERIA) {
    const diffs = pairs.map((p) =>
      Math.abs((p.a.scored?.ratings[c.id] ?? 0) - (p.b.scored?.ratings[c.id] ?? 0)),
    );
    exact[c.id] = diffs.filter((d) => d === 0).length / diffs.length;
    meanAbsDiff[c.id] = diffs.reduce((x, y) => x + y, 0) / diffs.length;
  }
  const order = (pick: (p: (typeof pairs)[number]) => number) =>
    [...pairs].sort((x, y) => pick(y) - pick(x) || (x.id < y.id ? -1 : 1)).map((p) => p.id);
  return {
    candidates: pairs.length,
    exact,
    meanAbsDiff,
    gateAgreement:
      pairs.filter((p) => p.a.scored?.gate.pass === p.b.scored?.gate.pass).length / pairs.length,
    scoreTau: kendallTau(
      order((p) => p.a.scored?.score ?? 0),
      order((p) => p.b.scored?.score ?? 0),
    ),
    meanAbsScoreDiff:
      pairs.reduce(
        (sum, p) => sum + Math.abs((p.a.scored?.score ?? 0) - (p.b.scored?.score ?? 0)),
        0,
      ) / pairs.length,
  };
}
