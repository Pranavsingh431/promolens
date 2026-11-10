import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { ingestScreenplayZip } from "../../src/server/ingest/ingest";
import {
  episodeOf,
  exportOf,
  readJob,
  resultsOf,
  routes,
  signIn,
  startJob,
  uploadZip,
} from "../support/backend-api";
import { call, createHarness, stageCounts, type Harness } from "../support/backend-harness";
import { buildUnseenShowZip } from "../support/unseen-show";

/**
 * Backend measurements on synthetic shows, with a local mock model. Run with
 * `npm run bench:backend`. Set BACKEND_TEST_DATABASE_URL to measure a real
 * PostgreSQL server instead of in-memory PGlite, and BENCH_OUT to save JSON.
 *
 * Route handlers are called in-process, so times are server work only: no
 * network, no TLS, no browser. Model calls go to a local mock, so pipeline time
 * is our own code plus the mock, never a real model's latency.
 */

const SIZES = [5, 20, 50];
const REPS = 3;

type Stats = { n: number; median: number; p90: number; max: number };
const stats = (values: number[]): Stats => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    n: sorted.length,
    median: round(at(0.5)),
    p90: round(at(0.9)),
    max: round(sorted.at(-1) ?? 0),
  };
};

async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await work();
  return { ms: performance.now() - start, value };
}

let h: Harness;
let cookie = "";
const report: Record<string, unknown> = {};

beforeAll(async () => {
  h = await createHarness();
  // Record starts only, so creating a job is timed apart from running it.
  h.onStart = async () => {};
  cookie = await signIn("alice");
});
afterAll(async () => {
  await h.close();
});

/** Database queries made by one piece of work. */
async function countQueries(work: () => Promise<unknown>): Promise<number> {
  const client = (h.db as unknown as { $client: { query: (...args: unknown[]) => unknown } })
    .$client;
  const spy = vi.spyOn(client, "query");
  await work();
  const count = spy.mock.calls.length;
  spy.mockRestore();
  return count;
}

it("measures the backend", async () => {
  report.environment = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    database: process.env.BACKEND_TEST_DATABASE_URL
      ? "PostgreSQL (real server)"
      : "PGlite (in memory)",
    storage: "in-memory object store",
    model: "local mock OpenRouter",
  };

  // Parsing and upload validation, by show size.
  const bySize: Record<string, unknown> = {};
  const finished: Array<{ size: number; jobId: string }> = [];
  for (const size of SIZES) {
    const parse: number[] = [];
    const complete: number[] = [];
    let bytes = 0;
    let showId = "";
    for (let rep = 0; rep < REPS; rep++) {
      const zip = buildUnseenShowZip(size, `bench-show-${size}-${rep}`);
      bytes = zip.length;
      parse.push((await timed(() => ingestScreenplayZip(zip))).ms);
      const upload = await timed(() => uploadZip(cookie, zip, `bench-${size}-${rep}.zip`));
      expect(upload.value.complete?.status).toBe(200);
      complete.push(upload.ms);
      if (rep === 0) showId = ((await upload.value.complete?.json()) as { showId: string }).showId;
    }

    // Job creation, then the whole pipeline with the mock model.
    const created = await timed(() => startJob(cookie, showId));
    expect(created.value.response.status).toBe(201);
    const jobId = created.value.job.id;
    const callsBefore = h.mock.chats().length;
    const heapBefore = process.memoryUsage();
    let peakRss = heapBefore.rss;
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 20);
    const pipeline = await timed(() => h.runAnalysis(jobId));
    clearInterval(sampler);
    expect((await readJob(cookie, jobId)).state).toBe("completed");
    finished.push({ size, jobId });
    bySize[`${size} episodes`] = {
      zipBytes: bytes,
      parseMs: stats(parse),
      uploadAndValidateMs: stats(complete),
      createJobMs: Math.round(created.ms * 100) / 100,
      pipelineMs: Math.round(pipeline.ms),
      modelCalls: h.mock.chats().length - callsBefore,
      peakRssMb: Math.round(peakRss / 1024 / 1024),
      heapGrowthMb: Math.round(
        (process.memoryUsage().heapUsed - heapBefore.heapUsed) / 1024 / 1024,
      ),
    };
  }
  report.bySize = bySize;

  // Reads on the largest finished analysis.
  const { jobId } = finished.at(-1) as { jobId: string };
  const reads: Record<string, unknown> = {};
  const sample = async (
    name: string,
    runs: number,
    work: () => Promise<Response>,
    expected = 200,
  ) => {
    const times: number[] = [];
    let size = 0;
    for (let i = 0; i < runs; i++) {
      const { ms, value } = await timed(work);
      expect(value.status).toBe(expected);
      size = (await value.arrayBuffer()).byteLength;
      times.push(ms);
    }
    reads[name] = { ms: stats(times), queries: await countQueries(work), responseBytes: size };
  };
  const status = () =>
    call(routes.getAnalysis, `/api/analyses/${jobId}`, { cookie }, { id: jobId });
  await sample("status", 40, status);
  await sample("list analyses", 10, () => call(routes.listAnalyses, "/api/analyses", { cookie }));
  await sample("results", 15, () => resultsOf(cookie, jobId));
  const tag = (await resultsOf(cookie, jobId)).headers.get("etag") as string;
  await sample(
    "results, unchanged (304)",
    15,
    () => resultsOf(cookie, jobId, { "if-none-match": tag }),
    304,
  );
  await sample("source episode", 15, () => episodeOf(cookie, jobId, 1));
  for (const format of ["promos-csv", "promos-json", "ranking-json"]) {
    await sample(`export ${format}`, 5, () => exportOf(cookie, jobId, format));
  }
  report.reads = reads;

  // The same show again: no new job, no new model calls.
  const again = buildUnseenShowZip(SIZES[0] as number, `bench-show-${SIZES[0]}-0`);
  const callsBefore = h.mock.chats().length;
  const reupload = await uploadZip(cookie, again, "renamed-copy.zip");
  const reused = (await reupload.complete?.json()) as { showId: string; duplicate: boolean };
  const restart = await startJob(cookie, reused.showId);
  report.reuse = {
    duplicateUploadDetected: reused.duplicate,
    status: restart.response.status,
    sameJob: restart.job.id === finished[0]?.jobId,
    newModelCalls: h.mock.chats().length - callsBefore,
  };

  // Parallel duplicate requests for a new show: one job, one set of model calls.
  const fresh = await uploadZip(cookie, buildUnseenShowZip(5, "bench-parallel"), "parallel.zip");
  const freshShow = ((await fresh.complete?.json()) as { showId: string }).showId;
  const parallel = await Promise.all(Array.from({ length: 8 }, () => startJob(cookie, freshShow)));
  const ids = new Set(parallel.map((p) => p.job.id));
  const before = h.mock.chats().length;
  for (const id of ids) await h.runAnalysis(id);
  const single = h.mock.chats().length - before;
  report.duplicates = {
    parallelRequests: parallel.length,
    distinctJobs: ids.size,
    statusCodes: parallel.map((p) => p.response.status).sort(),
    modelCallsForTheJob: single,
    modelCallsForSameSizeShow: (report.bySize as Record<string, { modelCalls: number }>)[
      "5 episodes"
    ]?.modelCalls,
  };
  report.modelCallsByStage = stageCounts(h);

  console.log(JSON.stringify(report, null, 2));
  if (process.env.BENCH_OUT)
    writeFileSync(process.env.BENCH_OUT, `${JSON.stringify(report, null, 2)}\n`);
  expect(ids.size).toBe(1);
});
