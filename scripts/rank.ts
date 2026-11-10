/**
 * Phase 4: evaluate and rank promo candidates.
 *
 * Usage:
 *   npm run rank -- <pack.zip> (--split development | --all | --episodes 2,4) [options]
 *
 * --episodes takes development or unsampled episodes only. Held-out episodes
 * are ranked only as part of --all, so they are never studied on their own.
 *
 * Options:
 *   --evaluator <id>          cold viewer, editorial, and pairwise model (default openai/gpt-6-luna)
 *   --screener <id>           quick first-read model (default anthropic/claude-haiku-5.5)
 *   --second-judge <id>       also run cold viewer and editorial with this model, to measure disagreement
 *   --replicates <n>          judge each clip n times with the evaluator, to measure stability (default 1)
 *   --shortlist <n>           clips sent to detailed assessment by priority (default 80)
 *   --explore <n>             random screened-out clips also assessed (default 12)
 *   --finalists <n>           clips compared head to head (default 16)
 *   --top <n>                 recommendations (default 10)
 *   --budget <usd>            cap for this run (default: what is left of the experiment budget)
 *   --experiment-budget <usd> cap for all ranking runs together, kept in the ledger (default 2)
 *   --max-requests <n>        hard request cap for this run
 *   --concurrency <n>         (default 4)
 *   --timeout <seconds>       per attempt (default 120)
 *   --attempts <n>            per judgment (default 3)
 *   --out <dir>               (default private/ranking)
 *   --candidates-dir <dir>    (default private/evaluation/candidates)
 *   --retry-refused           send requests again that the provider refused in an earlier run
 *   --dry-run                 no network calls; plan and worst-case estimate only
 *
 * Exit code: 0 complete, 1 partial (some judgments missing), 2 usage or setup error.
 * Prints counts, ids, and scores only. Never prints screenplay text or model output.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { candidateSetSchema, type CandidateSet } from "../src/domain/evaluation/candidate.ts";
import { evaluationSampleSchema } from "../src/domain/evaluation/sample.ts";
import {
  DEFAULT_RANKING_CONFIG,
  assertValidConfig,
  type RankingConfig,
} from "../src/domain/ranking/config.ts";
import {
  renderPromosCsv,
  renderShortlistMarkdown,
  toCandidateSet,
} from "../src/domain/ranking/output.ts";
import { buildRankingPool, POOL_CONFIG } from "../src/domain/ranking/pool.ts";
import {
  buildColdViewerPrompt,
  coldViewerJsonSchema,
} from "../src/domain/ranking/prompts/cold-viewer-v1.ts";
import {
  buildEditorialPrompt,
  editorialJsonSchema,
} from "../src/domain/ranking/prompts/editorial-v1.ts";
import {
  buildPairwisePrompt,
  pairwiseJsonSchema,
} from "../src/domain/ranking/prompts/pairwise-v1.ts";
import { buildScreenPrompt, screenJsonSchema } from "../src/domain/ranking/prompts/screen-v1.ts";
import { clipContext } from "../src/domain/ranking/windows.ts";
import { contentHash } from "../src/server/discovery/cache.ts";
import {
  WorkspaceError,
  assertSamePack,
  loadPack,
  readJson,
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/server/evaluation/workspace.ts";
import { InferenceError } from "../src/server/inference/errors.ts";
import { SpendGuard } from "../src/server/inference/limits.ts";
import { CHARS_PER_TOKEN_BOUND } from "../src/server/inference/openrouter.ts";
import { planRouting, type RoutingPlan } from "../src/server/inference/routing.ts";
import { LedgerError, readLedger, recordRun, spentSoFar } from "../src/server/ranking/ledger.ts";
import {
  DEFAULT_EVALUATOR_MODEL,
  DEFAULT_SCREEN_MODEL,
  RANKING_PRICE_SNAPSHOT,
  STAGE_SETTINGS,
} from "../src/server/ranking/models.ts";
import { createStageCall, stageModel } from "../src/server/ranking/live.ts";
import {
  runRanking,
  type RankingModels,
  type StageCall,
  type StageName,
  type StageStats,
} from "../src/server/ranking/run.ts";

const USAGE =
  "Usage: npm run rank -- <pack.zip> (--split development | --all) [--evaluator id] [--screener id] [--second-judge id] [--replicates n] [--shortlist n] [--explore n] [--finalists n] [--top n] [--budget usd] [--experiment-budget usd] [--retry-refused] [--dry-run]";

const VALUE_FLAGS = new Set([
  "split",
  "episodes",
  "evaluator",
  "screener",
  "second-judge",
  "replicates",
  "shortlist",
  "explore",
  "finalists",
  "top",
  "budget",
  "experiment-budget",
  "max-requests",
  "concurrency",
  "timeout",
  "attempts",
  "out",
  "candidates-dir",
]);
const BOOLEAN_FLAGS = new Set(["all", "dry-run", "retry-refused"]);

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

const [packPath, ...rest] = process.argv.slice(2);
if (!packPath || packPath.startsWith("--")) fail(USAGE);
const flags = new Map<string, string | true>();
for (let i = 0; i < rest.length; i++) {
  const name = (rest[i] ?? "").replace(/^--/, "");
  if (!(rest[i] ?? "").startsWith("--")) fail(USAGE);
  if (BOOLEAN_FLAGS.has(name)) flags.set(name, true);
  else if (VALUE_FLAGS.has(name) && rest[i + 1] !== undefined) flags.set(name, rest[++i] as string);
  else fail(`Unknown or incomplete option --${name}.\n${USAGE}`);
}
const text = (name: string) => {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
};
const numberFlag = (name: string, fallback: number, integer = true) => {
  const value = text(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    fail(`--${name} must be a positive ${integer ? "whole " : ""}number.`);
  }
  return parsed;
};

const out = text("out") ?? "private/ranking";
const candidatesDir = text("candidates-dir") ?? "private/evaluation/candidates";
const money = (usd: number | null) => (usd === null ? "n/a" : `$${usd.toFixed(4)}`);
const count = (n: number) => n.toLocaleString("en-US");

async function readSet(
  name: string,
  packSha256: string,
  required: boolean,
): Promise<CandidateSet | null> {
  const path = join(candidatesDir, name);
  try {
    await readFile(path);
  } catch {
    if (required) fail(`Missing ${path}. Run discovery (npm run discover) first.`);
    return null;
  }
  const set = await readJson(path, candidateSetSchema);
  assertSamePack(set.packSha256, packSha256, `Candidate file ${name}`);
  return set;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function statLine(s: StageStats): string {
  const errors = Object.entries(s.attemptErrors)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const messages = Object.entries(s.attemptMessages)
    .map(([k, v]) => `\n      ${v} x ${k}`)
    .join("");
  return (
    `  ${s.stage.padEnd(12)} ${s.model.padEnd(28)} asked ${s.requested}, live ${s.live}, cached ${s.cached}, failed ${s.failed}, skipped ${s.skipped}` +
    `${s.planned ? `, planned ${s.planned}` : ""}; attempts ${s.attempts}${errors ? ` (failed attempts: ${errors})` : ""}; ` +
    `tokens in ${count(s.usage.inputTokens)} / out ${count(s.usage.outputTokens)}; ${money(s.billedUsd)} billed, ${money(s.estimatedUsd)} est.; ` +
    `median ${((median(s.latenciesMs) ?? 0) / 1000).toFixed(1)} s; stage time ${(s.wallMs / 1000).toFixed(1)} s${messages}`
  );
}

async function main(): Promise<number> {
  const pack = await loadPack(packPath as string);
  const hybrid = await readSet("hybrid.json", pack.packSha256, true);
  const uniform = await readSet("uniform.json", pack.packSha256, false);
  const pool = buildRankingPool(hybrid as CandidateSet, uniform);

  let episodes: number[];
  let scopeLabel: string;
  if (flags.get("all") === true) {
    episodes = pack.show.episodes.map((e) => e.number);
    scopeLabel = "all";
  } else if (text("split") === "development") {
    const sample = await readJson(
      workspacePaths("private/evaluation").sample,
      evaluationSampleSchema,
    );
    assertSamePack(sample.packSha256, pack.packSha256, "The sample");
    episodes = sample.episodes.filter((e) => e.split === "development").map((e) => e.episode);
    scopeLabel = "development";
  } else if (text("episodes")) {
    const sample = await readJson(
      workspacePaths("private/evaluation").sample,
      evaluationSampleSchema,
    );
    const heldOut = new Set(
      sample.episodes.filter((e) => e.split === "held-out").map((e) => e.episode),
    );
    const known = new Set(pack.show.episodes.map((e) => e.number));
    episodes = (text("episodes") as string).split(",").map((n) => Number(n.trim()));
    if (episodes.some((n) => !known.has(n)))
      fail("--episodes lists an episode that is not in the pack.");
    if (episodes.some((n) => heldOut.has(n))) {
      fail("--episodes cannot include held-out episodes. They are ranked only as part of --all.");
    }
    scopeLabel = `episodes-${episodes.join("-")}`;
  } else {
    fail(
      `Choose --all, --split development, or --episodes. Held-out episodes are only ranked as part of --all.\n${USAGE}`,
    );
  }

  const config: RankingConfig = {
    ...DEFAULT_RANKING_CONFIG,
    screening: {
      ...DEFAULT_RANKING_CONFIG.screening,
      shortlist: numberFlag("shortlist", DEFAULT_RANKING_CONFIG.screening.shortlist),
      explore:
        text("explore") === "0"
          ? 0
          : numberFlag("explore", DEFAULT_RANKING_CONFIG.screening.explore),
    },
    pairwise: {
      ...DEFAULT_RANKING_CONFIG.pairwise,
      finalists: numberFlag("finalists", DEFAULT_RANKING_CONFIG.pairwise.finalists),
    },
    diversity: {
      ...DEFAULT_RANKING_CONFIG.diversity,
      top: numberFlag("top", DEFAULT_RANKING_CONFIG.diversity.top),
    },
  };
  assertValidConfig(config);
  const configHash = contentHash(config).slice(0, 12);
  const evaluator =
    text("evaluator") ?? process.env.PROMOLENS_EVALUATOR_MODEL ?? DEFAULT_EVALUATOR_MODEL;
  const screener = text("screener") ?? process.env.PROMOLENS_SCREEN_MODEL ?? DEFAULT_SCREEN_MODEL;
  const secondJudge = text("second-judge") ?? null;
  for (const id of [evaluator, screener, secondJudge]) {
    if (id && /:online\b/.test(id)) fail("Web-search model variants are not allowed.");
  }
  const models: RankingModels = {
    screen: stageModel(screener, "screen"),
    "cold-viewer": stageModel(evaluator, "cold-viewer"),
    editorial: stageModel(evaluator, "editorial"),
    pairwise: stageModel(evaluator, "pairwise"),
    secondJudge: secondJudge
      ? {
          "cold-viewer": stageModel(secondJudge, "cold-viewer"),
          editorial: stageModel(secondJudge, "editorial"),
        }
      : null,
  };
  const replicates = numberFlag("replicates", 1);
  const dryRun = flags.get("dry-run") === true;

  const ledgerPath = join(out, "ledger.json");
  let ledger = await readLedger(ledgerPath, {
    experiment: "phase4-ranking",
    budgetUsd: numberFlag("experiment-budget", 2, false),
  });
  const remaining = Math.max(0, ledger.budgetUsd - spentSoFar(ledger));
  const budget = Math.min(
    text("budget") ? numberFlag("budget", remaining, false) : remaining,
    remaining,
  );

  const scoped = pool.candidates.filter((c) =>
    c.segments.every((s) => episodes.includes(s.episode)),
  );
  console.log(
    `Ranking ${scopeLabel}: ${episodes.length} episode(s), ${scoped.length} candidates ` +
      `(pool ${pool.stats.hybrid} hybrid + ${pool.stats.uniformAdded} uniform coverage-gap windows of ${pool.stats.uniformAvailable}, ${POOL_CONFIG.version}).`,
  );
  console.log(
    `Config ${config.version} (${configHash}). Screener ${screener}; evaluator ${evaluator}${secondJudge ? `; second judge ${secondJudge}` : ""}; replicates ${replicates}.`,
  );
  console.log(
    `Experiment budget $${ledger.budgetUsd.toFixed(2)}: spent $${spentSoFar(ledger).toFixed(4)} in ${ledger.runs.length} earlier run(s); this run may spend up to $${budget.toFixed(4)}.${dryRun ? " DRY RUN." : ""}`,
  );
  if (!dryRun && budget <= 0) fail("The experiment budget is used up. Nothing was sent.", 1);

  const baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const attempts = numberFlag("attempts", 3);
  const timeoutMs = numberFlag("timeout", 120) * 1000;
  const perClip = 1 + 2 * replicates + (secondJudge ? 2 : 0);
  const maxRequests = numberFlag(
    "max-requests",
    (scoped.length * perClip +
      2 * config.corrections.maxPerRun +
      2 * config.pairwise.finalists * config.pairwise.window) *
      attempts,
  );
  const guard = new SpendGuard({ maxCostUsd: budget, maxRequests });

  let call: StageCall | null = null;
  const routings = new Map<string, RoutingPlan>();
  if (!dryRun) {
    if (!process.env.OPENROUTER_API_KEY) {
      try {
        process.loadEnvFile(".env");
      } catch {
        // No .env file; the check below explains what to do.
      }
    }
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) fail("Set OPENROUTER_API_KEY in .env or the environment, or use --dry-run.");
    for (const id of new Set([screener, evaluator, ...(secondJudge ? [secondJudge] : [])])) {
      const plan = await planRouting(id, "strict-zdr", { baseUrl });
      routings.set(id, plan);
      console.log(
        `Routing ${id}: ${plan.endpoints.map((e) => e.tag).join(", ")} (zdr, data collection denied, structured outputs required, ${plan.tokenLimitParam}). ` +
          `Max price $${(plan.pricing.inputPerToken * 1e6).toFixed(3)}/M in, $${(plan.pricing.outputPerToken * 1e6).toFixed(3)}/M out.`,
      );
    }
    call = createStageCall({ baseUrl, apiKey, timeoutMs, attempts, routings, guard });
  }

  const controller = new AbortController();
  process.once("SIGINT", () => {
    console.log(
      "\nStopping: cancelling requests in flight. Run the same command again to continue from the cache.",
    );
    controller.abort();
  });

  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")}-${scopeLabel}`;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // Ledger writes run one after another, so a late heartbeat can never overwrite the final entry.
  let ledgerWrites: Promise<void> = Promise.resolve();
  if (!dryRun) {
    const entry = () => ({
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      spentUsd: guard.spentUsd + guard.reservedUsd,
      billedUsd: null,
      requests: guard.requests,
      status: "running" as const,
    });
    ledger = await recordRun(ledgerPath, ledger, entry());
    heartbeat = setInterval(() => {
      ledgerWrites = ledgerWrites
        .then(() => recordRun(ledgerPath, ledger, entry()))
        .then((next) => {
          ledger = next;
        })
        .catch(() => {
          // A missed heartbeat only delays the running estimate; the final write still happens.
        });
    }, 5_000);
    heartbeat.unref();
  }

  const result = await runRanking({
    timeline: pack.timeline,
    packSha256: pack.packSha256,
    pool: pool.candidates,
    episodes,
    scopeLabel,
    config,
    configHash,
    models,
    cacheDir: join(out, "cache"),
    call,
    retryRefused: flags.get("retry-refused") === true,
    replicates,
    concurrency: numberFlag("concurrency", 4),
    runId,
    signal: controller.signal,
    log: (line) => console.log(line),
  });
  if (heartbeat) clearInterval(heartbeat);
  await ledgerWrites;
  const finishedAt = new Date();

  if (dryRun || !result.output) {
    const passing = [...result.assessments.values()].filter((a) => a.stageA.pass);
    const estimate = (
      stage: StageName,
      model: string,
      prompts: Array<{ system: string; user: string }>,
      schema: object,
    ) => {
      const price = RANKING_PRICE_SNAPSHOT[model];
      if (!price || !prompts.length) return null;
      const chars =
        prompts.reduce((n, p) => n + p.system.length + p.user.length, 0) / prompts.length;
      const tokens = (chars + JSON.stringify(schema).length) / CHARS_PER_TOKEN_BOUND;
      return tokens * price.inputPerToken + STAGE_SETTINGS[stage].maxTokens * price.outputPerToken;
    };
    const sample = passing.slice(0, 40);
    const perScreen = estimate(
      "screen",
      screener,
      sample.map((a) => buildScreenPrompt(a.stageA.view)),
      screenJsonSchema,
    );
    const perCold = estimate(
      "cold-viewer",
      evaluator,
      sample.map((a) => buildColdViewerPrompt(a.stageA.view)),
      coldViewerJsonSchema,
    );
    const perEditorial = estimate(
      "editorial",
      evaluator,
      sample.map((a) =>
        buildEditorialPrompt(
          a.stageA.view,
          clipContext(pack.timeline, a.candidate.segments, config.windows),
        ),
      ),
      editorialJsonSchema,
    );
    const perPair = estimate(
      "pairwise",
      evaluator,
      sample
        .slice(1)
        .map((a, i) => buildPairwisePrompt((sample[i] ?? a).stageA.view, a.stageA.view)),
      pairwiseJsonSchema,
    );
    const deep = Math.min(
      passing.length,
      config.screening.shortlist + config.screening.explore + 20,
    );
    const pairs = Math.ceil(
      config.pairwise.finalists * config.pairwise.window * (1 + config.pairwise.repeatShare),
    );
    const screenCalls = result.plan?.screenCalls ?? 0;
    const parts = [
      ["screen", screenCalls, perScreen],
      ["cold-viewer", deep * replicates, perCold],
      ["editorial", deep * replicates, perEditorial],
      ["corrections", config.corrections.maxPerRun * 2, perEditorial],
      ["pairwise", pairs, perPair],
    ] as const;
    let total = 0;
    for (const [stage, calls, per] of parts) {
      if (per !== null) total += calls * per;
      console.log(
        `  ${stage.padEnd(12)} up to ${calls} call(s), worst case ${per === null ? "unknown" : money(per)} each`,
      );
    }
    console.log(
      `Worst case if nothing is cached: about ${money(total)}${secondJudge ? " plus the second judge" : ""}. Cached judgments cost nothing. No requests were sent.`,
    );
    return 0;
  }

  const output = result.output;
  const totals = result.stats.reduce(
    (sum, s) => ({
      billed: s.billedUsd === null ? sum.billed : (sum.billed ?? 0) + s.billedUsd,
      estimated: sum.estimated + s.estimatedUsd,
      live: sum.live + s.live,
      cached: sum.cached + s.cached,
    }),
    { billed: null as number | null, estimated: 0, live: 0, cached: 0 },
  );
  console.log("\nStages:");
  for (const s of result.stats) console.log(statLine(s));
  console.log(
    `Total: ${totals.live} live judgments, ${totals.cached} from cache, ${guard.requests} HTTP requests, ${money(totals.billed)} billed (${money(totals.estimated)} estimated), ${((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1)} s.`,
  );
  console.log(`Status: ${output.status}. ${output.notes.join(" ")}`);
  console.log(`Counts: ${JSON.stringify(output.counts)}`);
  console.log(`Screening audit: ${JSON.stringify(result.audit)}`);
  console.log(`Stability: ${JSON.stringify(result.stability)}`);
  console.log("\nShortlist (ids and numbers only):");
  for (const rec of output.shortlist) {
    const r = rec.criteria;
    console.log(
      `  ${String(rec.rank).padStart(2)}. ${rec.clipKey.padEnd(24)} score ${rec.editorialScore.toFixed(1).padStart(5)} ${rec.tier.padEnd(9)} ` +
        `h${r.hook.rating} c${r.cliffhanger.rating} cl${r.clarity.rating} e${r.emotion.rating} b${r.boundaries.rating}  ` +
        `${rec.ranking.pairwise ? `pairwise ${rec.ranking.pairwise.wins}-${rec.ranking.pairwise.losses}-${rec.ranking.pairwise.ties}` : "no comparisons"}  ${rec.provenance.methods.join("+")}`,
    );
  }

  const runDir = join(out, "runs", runId);
  const methodVersion = `${config.version}|${configHash}|screen:${screener}|eval:${evaluator}`;
  await writeJsonAtomic(join(runDir, "ranking.json"), output);
  await writeTextAtomic(join(runDir, "shortlist.md"), renderShortlistMarkdown(output));
  if (result.promos) {
    await writeJsonAtomic(join(runDir, "promos.json"), result.promos);
    await writeTextAtomic(join(runDir, "promos.csv"), renderPromosCsv(result.promos));
  }
  await writeJsonAtomic(join(runDir, "judgments.json"), {
    runId,
    assessments: [...result.assessments.values()].map((a) => ({
      candidateId: a.candidate.id,
      clipKey: a.candidate.clipKey,
      stageA: {
        pass: a.stageA.pass,
        reasons: a.stageA.reasons,
        flags: a.stageA.flags,
        cuts: a.stageA.cuts,
      },
      screen: a.screen,
      screenStatus: a.screenStatus,
      screenError: a.screenError,
      priority: a.priority,
      selection: a.selection,
      deepStatus: a.deepStatus,
      deepError: a.deepError,
      cold: a.cold,
      editorial: a.editorial,
      clarity: a.clarity,
      editorialResult: a.editorialResult
        ? {
            ...a.editorialResult,
            evidence: Object.fromEntries(
              Object.entries(a.editorialResult.evidence).map(([k, events]) => [
                k,
                events.map((e) => e.ref),
              ]),
            ),
          }
        : null,
      scored: a.scored,
      derived: a.derived,
      correction: a.correction,
    })),
    replicates: result.replicates,
    pairs: result.pairs,
    strengths: [...result.strengths.values()],
  });
  await writeJsonAtomic(join(runDir, "manifest.json"), {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    node: process.version,
    packSha256: pack.packSha256,
    scope: { label: scopeLabel, episodes },
    pool: pool.stats,
    config,
    configHash,
    models,
    routing: Object.fromEntries(routings),
    replicates,
    budget: {
      run: budget,
      experiment: ledger.budgetUsd,
      spentBefore: spentSoFar(ledger) - (guard.spentUsd + guard.reservedUsd),
    },
    requestsSent: guard.requests,
    totals,
    stats: result.stats,
    stability: result.stability,
    audit: result.audit,
    status: output.status,
    counts: output.counts,
    fatal: result.fatal,
  });
  ledger = await recordRun(ledgerPath, ledger, {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    spentUsd: guard.spentUsd,
    billedUsd: totals.billed,
    requests: guard.requests,
    status: "finished",
  });
  console.log(
    `\nSaved run ${runId} to ${runDir}. Experiment spend so far: $${spentSoFar(ledger).toFixed(4)} of $${ledger.budgetUsd.toFixed(2)}.`,
  );

  if (output.status === "complete") {
    const set = toCandidateSet(output, result.assessments, methodVersion);
    await writeJsonAtomic(join(candidatesDir, "ranked.json"), set);
    console.log(
      `Ranked candidate set for evaluation: ${join(candidatesDir, "ranked.json")} (${set.candidates.length} clips).`,
    );
    return 0;
  }
  console.log(
    "The run is partial, so the evaluation candidate set was not updated. Run the same command again to finish it.",
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof WorkspaceError || error instanceof LedgerError) fail(error.message, 2);
    if (error instanceof InferenceError) fail(`${error.kind}: ${error.message}`, 2);
    throw error;
  });
