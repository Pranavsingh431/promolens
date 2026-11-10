import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, expect, it } from "vitest";

import { estimateAnalysis } from "../../src/domain/estimate";
import { workProfile, MEASURED } from "../../src/server/analysis/calibration";
import { answerVaried } from "../support/backend-model";
import { readJob, resultsOf, signIn, uploadShow } from "../support/backend-api";
import { call, createHarness, type Harness } from "../support/backend-harness";
import { buildUnseenShowZip } from "../support/unseen-show";
import { POST as postAnalyses } from "../../src/app/api/analyses/route";

/**
 * How the requested count and the speed settings change real pipeline work.
 * Run with `npm run bench:backend`; set BENCH_OUT to save JSON.
 *
 * The real pipeline runs in-process on a made-up 50-episode show. The mock model
 * waits for a latency drawn from each stage's measured distribution (median and
 * 95th percentile, see src/server/analysis/calibration.ts), scaled down by
 * SCALE so a run takes seconds. Call counts are exact. Times are model time
 * scaled back up plus our own code's real time, so they show the shape of the
 * change, not a promise for production.
 */

const SCALE = 0.02;
const EPISODES = 50;
const SCHEMA_STAGE: Record<string, keyof (typeof MEASURED)[string]> = {
  promo_proposals: "discovery",
  promo_screen: "screen",
  cold_viewer: "cold-viewer",
  editorial_judgment: "editorial",
  pairwise_judgment: "pairwise",
};
const MODEL_OF: Record<string, string> = {
  discovery: "anthropic/claude-haiku-5.5",
  screen: "anthropic/claude-haiku-5.5",
  "cold-viewer": "openai/gpt-6-luna",
  editorial: "openai/gpt-6-luna",
  pairwise: "openai/gpt-6-luna",
};

/** Seeded log-normal latency with the measured median and 95th percentile. */
function latencySampler(seed: number) {
  let state = seed;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return (state + 1) / (2 ** 31 + 1);
  };
  return (stage: string) => {
    const m = MEASURED[MODEL_OF[stage] as string]?.[stage as "screen"];
    if (!m) return 0;
    const sigma = Math.log(m.p95Ms / m.p50Ms) / 1.645;
    const normal = Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
    return m.p50Ms * Math.exp(sigma * normal);
  };
}

let h: Harness;
let cookie = "";
let showId = "";
let inFlight = 0;
let peak = 0;
const report: Record<string, unknown> = {};

beforeAll(async () => {
  h = await createHarness({ limits: { stepBudgetMs: 600_000, modelTimeoutMs: 60_000 } });
  h.onStart = async () => {};
  cookie = await signIn("alice");
  ({ showId } = await uploadShow(
    cookie,
    buildUnseenShowZip(EPISODES, "bench-show", true),
    "bench.zip",
  ));
});
afterAll(async () => {
  if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(report, null, 2));
  await h.close();
});

async function run(label: string, count: number, settings: { concurrency: number; batch: number }) {
  // A fresh judgment cache each time, unless the run is a continuation.
  const sample = latencySampler(4242);
  h.mock.setChat(async (body) => {
    const name = (body.response_format as { json_schema?: { name?: string } } | undefined)
      ?.json_schema?.name;
    const stage = SCHEMA_STAGE[name ?? ""] ?? "screen";
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, sample(stage) * SCALE));
    inFlight -= 1;
    return answerVaried(body);
  });
  (h.config.limits as { modelConcurrency: number }).modelConcurrency = settings.concurrency;
  h.discoveryBatch = settings.batch;
  const before = h.mock.chats().length;
  const stagesBefore = countStages(h);
  peak = 0;
  const started = performance.now();
  const response = await call(postAnalyses, "/api/analyses", {
    method: "POST",
    cookie,
    json: { showId, count },
  });
  const { job } = (await response.json()) as { job: { id: string } };
  const t0 = performance.now();
  await h.runAnalysis(job.id);
  const ms = performance.now() - t0;
  const finished = await readJob(cookie, job.id);
  const results = (await (await resultsOf(cookie, job.id)).json()) as {
    ranking: { counts: Record<string, number>; shortlist: unknown[] };
  };
  const stages = diff(countStages(h), stagesBefore);
  const modelMs = ms; // model waits are scaled; report both raw and as model-time equivalent
  const row = {
    label,
    count,
    ...settings,
    state: finished.state,
    calls: h.mock.chats().length - before,
    stages,
    returned: results.ranking.shortlist.length,
    assessed: results.ranking.counts.assessed,
    finalists: results.ranking.counts.finalists,
    comparisons: results.ranking.counts.comparisonsJudged,
    peakConcurrency: peak,
    wallMs: Math.round(performance.now() - started),
    pipelineMs: Math.round(modelMs),
    modelTimeEquivalentMin: Math.round((modelMs / SCALE / 60_000) * 10) / 10,
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
  };
  report[label] = row;
  console.log(JSON.stringify(row));
  return row;
}

function countStages(harness: Harness): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const request of harness.mock.chats()) {
    const name = (request.body as { response_format?: { json_schema?: { name?: string } } })
      .response_format?.json_schema?.name;
    const stage = SCHEMA_STAGE[name ?? ""] ?? "other";
    counts[stage] = (counts[stage] ?? 0) + 1;
  }
  return counts;
}
const diff = (after: Record<string, number>, before: Record<string, number>) =>
  Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - (before[k] ?? 0)]));

async function clearJudgmentCache() {
  // Each measured run starts cold, as a first analysis of a show would.
  const { inferenceCache, analysisJobs, jobSpend, jobEvents, rateLimits } =
    await import("../../src/server/db/schema");
  for (const table of [jobSpend, jobEvents, analysisJobs, inferenceCache, rateLimits]) {
    await h.db.delete(table);
  }
}

it("measures work and time against the requested count and speed settings", async () => {
  const before = { concurrency: 4, batch: 8 };
  const after = { concurrency: 8, batch: 25 };
  const rows = [];
  await clearJudgmentCache();
  rows.push(await run("before: 10 promos, concurrency 4, batch 8", 10, before));
  await clearJudgmentCache();
  rows.push(await run("concurrency 4, batch 25", 10, { concurrency: 4, batch: 25 }));
  for (const count of [1, 5, 10, 20, 50, 100, 300]) {
    await clearJudgmentCache();
    rows.push(await run(`after: ${count} promos`, count, after));
  }
  // Continuation: 10 first, then 50 on the same show reuses every cached judgment.
  await clearJudgmentCache();
  await run("continuation: first 10", 10, after);
  const more = await run("continuation: then 50", 50, after);
  report.continuation = more;

  const estimates = Object.fromEntries(
    [1, 5, 10, 20, 50, 100, 300].map((count) => {
      const profile = { ...workProfile(h.config, {}), concurrency: after.concurrency };
      const e = estimateAnalysis(profile, { episodes: EPISODES, requested: count });
      return [count, { timeMs: e.timeMs, costUsd: e.costUsd, requests: e.requests }];
    }),
  );
  report.estimates = estimates;
  console.log(JSON.stringify({ estimates }));
  expect(rows.every((r) => r.state === "completed" || r.state === "partial")).toBe(true);
});
