/**
 * AI candidate discovery. One model call per episode, with strict privacy
 * routing, a spending cap, a request cap, a file cache, and resume.
 *
 * Usage:
 *   npm run discover -- <pack.zip> (--all | --split development | --episodes 2,4,9) [options]
 *   npm run discover -- <pack.zip> --resume
 *   npm run discover -- <pack.zip> --merge-only
 *
 * Options:
 *   --variant writer-context|screen-only   (default writer-context)
 *   --model <id>                           (default anthropic/claude-haiku-5.5)
 *   --effort low|medium|high               (default low)
 *   --max-tokens <n>                       (default 12000)
 *   --budget <usd>                         (default 2)
 *   --max-requests <n>                     (default 3 per episode)
 *   --concurrency <n>                      (default 2)
 *   --timeout <seconds>                    (default 120)
 *   --attempts <n>                         (default 3)
 *   --out <dir>                            (default private/discovery)
 *   --candidates-dir <dir>                 (default private/evaluation/candidates)
 *   --dry-run                              (no network calls; estimates only)
 *   --fresh                                (ignore the cache; a later --resume keeps ignoring older entries)
 *   --allow-safety-retention               (accept endpoints with safety retention)
 *
 * Exit code: 0 all requested episodes processed, 1 some failed or skipped, 2 usage or setup error.
 * Never prints screenplay text or model output.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { buildHybridSet } from "../src/domain/discovery/merge.ts";
import {
  CONTEXT_VARIANTS,
  type ContextVariant,
} from "../src/domain/discovery/prompts/discovery-v1.ts";
import { proposalJsonSchema } from "../src/domain/discovery/proposal.ts";
import {
  candidateSetSchema,
  type Candidate,
  type CandidateSet,
} from "../src/domain/evaluation/candidate.ts";
import { evaluationSampleSchema } from "../src/domain/evaluation/sample.ts";
import { createDiscoveryComplete } from "../src/server/discovery/live.ts";
import { DEFAULT_DISCOVERY_MODEL, PRICE_SNAPSHOT } from "../src/server/discovery/models.ts";
import {
  methodFor,
  runDiscovery,
  summarizeRuns,
  type DiscoveryConfig,
  type EpisodeRun,
} from "../src/server/discovery/run.ts";
import {
  WorkspaceError,
  loadPack,
  readJson,
  workspacePaths,
  writeJsonAtomic,
} from "../src/server/evaluation/workspace.ts";
import { InferenceError } from "../src/server/inference/errors.ts";
import { SpendGuard } from "../src/server/inference/limits.ts";
import {
  CHARS_PER_TOKEN_BOUND,
  worstCaseUsd,
  type Effort,
  type ModelConfig,
} from "../src/server/inference/openrouter.ts";
import { planRouting, type PrivacyMode } from "../src/server/inference/routing.ts";

const USAGE =
  "Usage: npm run discover -- <pack.zip> (--all | --split development | --episodes 2,4,9 | --resume | --merge-only) [--variant writer-context|screen-only] [--model id] [--effort low|medium|high] [--budget usd] [--max-requests n] [--concurrency n] [--dry-run] [--fresh]";

const VALUE_FLAGS = new Set([
  "episodes",
  "split",
  "variant",
  "model",
  "effort",
  "max-tokens",
  "budget",
  "max-requests",
  "concurrency",
  "timeout",
  "attempts",
  "out",
  "candidates-dir",
]);
const BOOLEAN_FLAGS = new Set([
  "all",
  "dry-run",
  "fresh",
  "resume",
  "merge-only",
  "allow-safety-retention",
]);

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

const out = text("out") ?? "private/discovery";
const candidatesDir = text("candidates-dir") ?? "private/evaluation/candidates";
const lastRunPath = join(out, "last-run.json");
const money = (usd: number | null) => (usd === null ? "n/a" : `$${usd.toFixed(4)}`);
const count = (n: number) => n.toLocaleString("en-US");
const schemaChars = JSON.stringify(proposalJsonSchema).length;

async function loadSets(packSha256: string): Promise<CandidateSet[]> {
  let names: string[] = [];
  try {
    names = (await readdir(candidatesDir))
      .filter((n) => n.endsWith(".json") && n !== "hybrid.json" && n !== "ranked.json")
      .sort();
  } catch {
    return [];
  }
  const sets: CandidateSet[] = [];
  for (const name of names) {
    const set = await readJson(join(candidatesDir, name), candidateSetSchema);
    if (set.packSha256 === packSha256) sets.push(set);
  }
  return sets;
}

async function writeHybrid(pack: Awaited<ReturnType<typeof loadPack>>) {
  const sets = await loadSets(pack.packSha256);
  if (!sets.some((s) => s.method.startsWith("ai-"))) return;
  const { set, stats } = buildHybridSet(sets, pack.timeline, pack.packSha256);
  await writeJsonAtomic(join(candidatesDir, "hybrid.json"), set);
  console.log(
    `Hybrid pool: ${count(set.candidates.length)} clips from ${sets.map((s) => s.method).join(", ")}. ` +
      `Groups ${stats.groups}: AI only ${stats.aiOnly}, baseline only ${stats.baselineOnly}, shared ${stats.shared}. ` +
      `Uniform fallback episodes: ${stats.uniformFallbackEpisodes.join(", ") || "none"}.`,
  );
}

/** Replaces this run's episodes in the saved AI set and keeps the others. */
async function writeAiSet(
  pack: Awaited<ReturnType<typeof loadPack>>,
  config: DiscoveryConfig,
  processed: number[],
  candidates: Candidate[],
) {
  const { method, methodVersion } = methodFor(config);
  const path = join(candidatesDir, `${method}.json`);
  let kept: Candidate[] = [];
  try {
    const existing = candidateSetSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (existing.methodVersion === methodVersion && existing.packSha256 === pack.packSha256) {
      kept = existing.candidates.filter((c) => !processed.includes(c.segments[0]?.episode ?? 0));
    }
  } catch {
    kept = [];
  }
  const merged = [...kept, ...candidates]
    .sort(
      (a, b) => (a.segments[0]?.episode ?? 0) - (b.segments[0]?.episode ?? 0) || a.rank - b.rank,
    )
    .map((c, index) => ({ ...c, rank: index + 1 }));
  const set: CandidateSet = candidateSetSchema.parse({
    method,
    methodVersion,
    packSha256: pack.packSha256,
    candidates: merged,
    rejected: {},
    proposals: merged.length,
  });
  await writeJsonAtomic(path, set);
  return path;
}

function line(run: EpisodeRun): string {
  const episode = `E${String(run.episode).padStart(3, "0")}`;
  if (run.status === "planned") {
    return `${episode} planned   up to ${count(Math.ceil((run.promptChars + schemaChars) / CHARS_PER_TOKEN_BOUND))} prompt tokens, up to ${money(run.estimatedUsd)}`;
  }
  if (run.status === "failed" || run.status === "skipped") {
    return `${episode} ${run.status.padEnd(9)} ${run.error?.kind ?? ""}: ${run.error?.message ?? ""}`;
  }
  const rejected = Object.values(run.rejected).reduce((a, b) => a + b, 0);
  const tokens =
    run.status === "cached"
      ? "from cache"
      : `in ${count(run.usage.inputTokens)} / out ${count(run.usage.outputTokens)} tok, ${money(run.billedUsd ?? run.estimatedUsd)} ${run.billedUsd === null ? "est." : "billed"}, ${(run.latencyMs / 1000).toFixed(1)} s, ${run.provider ?? "?"}`;
  return `${episode} ${run.status.padEnd(9)} ${run.proposals} proposals: ${run.accepted} valid, ${rejected} rejected   ${tokens}`;
}

async function main() {
  const pack = await loadPack(packPath as string);

  if (flags.get("merge-only") === true) {
    await writeHybrid(pack);
    return 0;
  }

  type Options = {
    episodes: number[];
    config: DiscoveryConfig;
    budget: number;
    maxRequests: number;
    concurrency: number;
    timeoutMs: number;
    attempts: number;
  };
  let options: Options;
  const resume = flags.get("resume") === true;
  const fresh = flags.get("fresh") === true;
  if (resume && fresh) fail("--resume and --fresh cannot be combined.");
  /** Set when a fresh run is resumed: cache entries older than that run are ignored. */
  let cacheNotBefore: string | null = null;
  if (resume) {
    try {
      const saved = JSON.parse(await readFile(lastRunPath, "utf8")) as {
        options: Options;
        cacheNotBefore?: string | null;
      };
      options = saved.options;
      cacheNotBefore = saved.cacheNotBefore ?? null;
    } catch {
      fail(`Nothing to resume: ${lastRunPath} not found.`);
    }
    console.log(
      "Resuming the last run with its saved settings. Episodes it finished are not sent again.",
    );
  } else {
    let episodes: number[];
    if (flags.get("all") === true) episodes = pack.show.episodes.map((e) => e.number);
    else if (text("split")) {
      if (text("split") !== "development")
        fail("--split only accepts development. Use --all for the whole show.");
      const sample = await readJson(
        workspacePaths("private/evaluation").sample,
        evaluationSampleSchema,
      );
      episodes = sample.episodes.filter((e) => e.split === "development").map((e) => e.episode);
    } else if (text("episodes")) {
      episodes = (text("episodes") as string).split(",").map((s) => Number(s.trim()));
      const known = new Set(pack.show.episodes.map((e) => e.number));
      if (episodes.some((n) => !known.has(n)))
        fail("--episodes lists an episode that is not in the pack.");
    } else {
      fail(`Choose episodes with --all, --split development, or --episodes.\n${USAGE}`);
    }
    const variant = text("variant") ?? "writer-context";
    if (!(CONTEXT_VARIANTS as readonly string[]).includes(variant))
      fail("--variant must be writer-context or screen-only.");
    const effort = text("effort") ?? "low";
    if (!["low", "medium", "high"].includes(effort)) fail("--effort must be low, medium, or high.");
    const attempts = numberFlag("attempts", 3);
    options = {
      episodes,
      config: {
        model: text("model") ?? process.env.PROMOLENS_DISCOVERY_MODEL ?? DEFAULT_DISCOVERY_MODEL,
        variant: variant as ContextVariant,
        maxTokens: numberFlag("max-tokens", 12_000),
        reasoningEffort: effort as Effort,
        privacy: (flags.get("allow-safety-retention") === true
          ? "allow-safety-retention"
          : "strict-zdr") as PrivacyMode,
      },
      budget: numberFlag("budget", 2, false),
      maxRequests: numberFlag("max-requests", episodes.length * attempts),
      concurrency: numberFlag("concurrency", 2),
      timeoutMs: numberFlag("timeout", 120) * 1000,
      attempts,
    };
  }

  const { config } = options;
  const dryRun = flags.get("dry-run") === true;
  console.log(
    `Discovery: ${options.episodes.length} episode(s), model ${config.model}, ${config.variant}, effort ${config.reasoningEffort}, ` +
      `max ${config.maxTokens} tokens, ${config.privacy}, budget $${options.budget.toFixed(2)}, ` +
      `max ${options.maxRequests} requests, concurrency ${options.concurrency}${dryRun ? ", DRY RUN" : ""}.`,
  );

  let modelConfig: ModelConfig | undefined;
  let routing: Awaited<ReturnType<typeof planRouting>> | undefined;
  const guard = new SpendGuard({ maxCostUsd: options.budget, maxRequests: options.maxRequests });
  const baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

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
    routing = await planRouting(config.model, config.privacy, { baseUrl });
    console.log(
      `Routing: ${routing.endpoints.map((e) => e.tag).join(", ")} (zdr, data collection denied, structured outputs required). ` +
        `Max price $${(routing.pricing.inputPerToken * 1e6).toFixed(3)}/M in, $${(routing.pricing.outputPerToken * 1e6).toFixed(3)}/M out.`,
    );
    try {
      const key = await fetch(`${baseUrl}/key`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      const data = ((await key.json()) as { data?: { limit_remaining?: unknown; usage?: unknown } })
        .data;
      if (data && typeof data.usage === "number") {
        console.log(
          `Key: ${typeof data.limit_remaining === "number" ? `$${data.limit_remaining.toFixed(2)} left on its limit` : "no key limit set"}, $${data.usage.toFixed(4)} used so far.`,
        );
      }
    } catch {
      console.log("Key: could not read credit status; continuing.");
    }
    modelConfig = {
      baseUrl,
      apiKey,
      model: config.model,
      maxTokens: config.maxTokens,
      reasoningEffort: config.reasoningEffort,
      timeoutMs: options.timeoutMs,
      maxAttempts: options.attempts,
      provider: routing.provider,
      pricing: routing.pricing,
      tokenLimitParam: routing.tokenLimitParam,
    };
  }

  const snapshot = PRICE_SNAPSHOT[config.model];
  const controller = new AbortController();
  process.once("SIGINT", () => {
    console.log("\nStopping: cancelling requests in flight. Run again with --resume to continue.");
    controller.abort();
  });

  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")}-${config.variant}`;
  const result = await runDiscovery({
    show: pack.show,
    timeline: pack.timeline,
    episodes: options.episodes,
    config,
    cacheDir: join(out, "cache"),
    dryRun,
    fresh,
    ...(cacheNotBefore ? { cacheNotBefore } : {}),
    concurrency: options.concurrency,
    signal: controller.signal,
    ...(modelConfig
      ? {
          complete: createDiscoveryComplete(modelConfig as ModelConfig, guard),
        }
      : {}),
    ...(snapshot
      ? {
          estimateUsd: (prompt) =>
            worstCaseUsd(
              { ...prompt, jsonSchema: proposalJsonSchema },
              { pricing: snapshot, maxTokens: config.maxTokens },
            ),
        }
      : {}),
    onEpisode: (run) => console.log(line(run)),
  });

  const totals = summarizeRuns(result.runs);
  const finishedAt = new Date();
  console.log(
    `\nProcessed ${totals.processed}/${totals.episodes} episodes (${totals.byStatus.succeeded} called, ${totals.cacheHits} from cache); ` +
      `${totals.withCandidates} with at least one valid candidate; ${totals.byStatus.failed} failed, ${totals.byStatus.skipped} skipped.` +
      (totals.cacheCorrupt ? ` Damaged cache entries ignored: ${totals.cacheCorrupt}.` : ""),
  );
  if (!dryRun) {
    console.log(
      `Proposals ${totals.proposals}: ${totals.accepted} valid, rejected ${JSON.stringify(totals.rejected)}. ` +
        `Proposals citing unknown events: ${totals.proposalsWithUnknownRefs}. Adjusted boundaries: ${totals.adjusted}.`,
    );
    console.log(
      `Tokens in ${count(totals.usage.inputTokens)}, out ${count(totals.usage.outputTokens)} (reasoning ${count(totals.usage.reasoningTokens)}). ` +
        `Cost ${money(totals.billedUsd)} billed, ${money(totals.estimatedUsd)} estimated. Requests sent ${guard.requests}. ` +
        `Time ${((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1)} s.`,
    );
  } else {
    console.log(
      `Estimated worst case for uncached episodes: ${money(totals.estimatedUsd)}${snapshot ? ` (prices checked ${snapshot.checked})` : " (no price snapshot for this model)"}. No requests were sent.`,
    );
  }

  if (!dryRun) {
    const runDir = join(out, "runs", runId);
    await writeJsonAtomic(join(runDir, "manifest.json"), {
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      node: process.version,
      packSha256: pack.packSha256,
      options,
      method: methodFor(config),
      routing: routing ?? null,
      totals,
      requestsSent: guard.requests,
      episodes: result.runs,
    });
    await writeJsonAtomic(join(runDir, "proposals.json"), result.details);
    await writeJsonAtomic(lastRunPath, {
      runId,
      options,
      cacheNotBefore: fresh ? startedAt.toISOString() : cacheNotBefore,
    });
    const processed = result.runs
      .filter((r) => r.status === "succeeded" || r.status === "cached")
      .map((r) => r.episode);
    const path = await writeAiSet(pack, config, processed, result.candidates);
    console.log(`Saved run ${runId} to ${runDir}; candidates to ${path}.`);
    await writeHybrid(pack);
  }
  return totals.processed === totals.episodes || (dryRun && totals.byStatus.failed === 0) ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof WorkspaceError) fail(error.message, 2);
    if (error instanceof InferenceError) fail(`${error.kind}: ${error.message}`, 2);
    throw error;
  });
