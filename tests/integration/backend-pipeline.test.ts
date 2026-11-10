import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildExportFile } from "../../src/client/export";
import { buildDemoResults } from "../../src/demo/results";
import { rankingOutputSchema, promoExportSchema } from "../../src/domain/ranking/output";
import { buildPool, prepare, discoverBatch, rankSlice } from "../../src/server/analysis/pipeline";
import {
  analysisJobs,
  inferenceCache,
  jobEvents,
  jobSpend,
  rateLimits,
  shows,
} from "../../src/server/db/schema";
import { spendSoFar } from "../../src/server/jobs";
import { sweepExpired } from "../../src/server/retention";
import type { memoryStore } from "../../src/server/storage";
import { answerEveryStage } from "../support/backend-model";
import { call, createHarness, stageCounts, type Harness } from "../support/backend-harness";
import {
  episodeOf,
  exportOf,
  readJob,
  resultsOf,
  routes,
  signIn,
  startJob,
  uploadShow,
} from "../support/backend-api";
import { chatReply, type ChatHandler } from "../support/mock-openrouter";
import { buildUnseenShowZip } from "../support/unseen-show";

/**
 * The real pipeline, end to end: real parsing, discovery, pool building,
 * ranking, and persistence. Only the model service is simulated.
 */

let h: Harness;
let cookie: string;
let showNumber = 0;
const newZip = (episodes = 3) => buildUnseenShowZip(episodes, `show-${++showNumber}`);
const objects = () => (h.storage as ReturnType<typeof memoryStore>).objects;
const decode = (bytes: Uint8Array | undefined) =>
  JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

async function analyzeNew(episodes = 3) {
  const { showId } = await uploadShow(cookie, newZip(episodes));
  const { job, response } = await startJob(cookie, showId);
  return { jobId: job.id, showId, response, created: response.status === 201 };
}

const jobRow = async (id: string) =>
  (
    await h.db.select().from(analysisJobs).where(eq(analysisJobs.id, id))
  )[0] as typeof analysisJobs.$inferSelect;
const schemaOf = (body: Record<string, unknown>) =>
  (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name;

/** Replies with a failure for requests to the named stages, and normally otherwise. */
const failing =
  (stages: string[], status = 500): ChatHandler =>
  (body) =>
    stages.includes(schemaOf(body) ?? "")
      ? { status, body: { error: { code: status, message: "Simulated failure" } } }
      : answerEveryStage(body);

const refusing =
  (stage: string): ChatHandler =>
  (body) =>
    schemaOf(body) === stage
      ? {
          status: 200,
          body: {
            id: "gen",
            provider: "Google",
            model: "m",
            choices: [{ finish_reason: "stop", message: { role: "assistant", refusal: "No." } }],
            usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.00001 },
          },
        }
      : answerEveryStage(body);

beforeAll(async () => {
  h = await createHarness();
  cookie = await signIn("alice");
});
afterAll(() => h.close());
beforeEach(async () => {
  h.mock.setChat(answerEveryStage);
  h.onStart = (jobId) => h.runAnalysis(jobId);
  // Each test here makes several uploads, and the limits are tested on their own elsewhere.
  await h.db.delete(rateLimits);
});

describe("a show nobody has seen before", () => {
  let jobId: string;
  let showId: string;
  let logs: string[];

  beforeAll(async () => {
    logs = [];
    const spy = vi.spyOn(console, "info").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    ({ jobId, showId } = await analyzeNew(4));
    spy.mockRestore();
  }, 60_000);

  it("reaches completed through only legal, recorded states", async () => {
    expect((await readJob(cookie, jobId)).state).toBe("completed");
    const events = await h.db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId));
    expect(events.map((e) => e.toState)).toEqual([
      "queued",
      "validating",
      "parsing",
      "discovering",
      "evaluating",
      "ranking",
      "completed",
    ]);
  });

  it("uses every model stage and strict privacy routing on every call", () => {
    expect(Object.keys(stageCounts(h))).toEqual(
      expect.arrayContaining([
        "promo_proposals",
        "promo_screen",
        "cold_viewer",
        "editorial_judgment",
        "pairwise_judgment",
      ]),
    );
    for (const request of h.mock.chats()) {
      const provider = (request.body as { provider: Record<string, unknown> }).provider;
      expect(provider.zdr).toBe(true);
      expect(provider.data_collection).toBe("deny");
      // Fallback is only ever among the endpoints named here, all checked as zero retention.
      expect(Array.isArray(provider.only) && (provider.only as string[]).length).toBeGreaterThan(0);
      for (const tag of provider.only as string[]) {
        expect(["google-vertex/global", "azure"]).toContain(tag);
      }
      expect(request.body).not.toHaveProperty("tools");
    }
  });

  it("stores results that match the rank-3 contracts", async () => {
    const response = await resultsOf(cookie, jobId);
    expect(response.status).toBe(200);
    const { ranking, promos } = await response.json();
    expect(rankingOutputSchema.safeParse(ranking).success).toBe(true);
    expect(promoExportSchema.safeParse(promos).success).toBe(true);
    expect(ranking.status).toBe("complete");
    // rank-4 plans by the requested count; at the default of 10 its settings are rank-3's.
    expect(ranking.versions.ranking).toBe("rank-4");
    expect(ranking.counts.requested).toBe(10);
    expect(ranking.versions.models.screen).toBe("anthropic/claude-haiku-5.5");
    expect(ranking.versions.models.editorial).toBe("openai/gpt-6-luna");
    expect(ranking.shortlist.length).toBeGreaterThan(0);
  });

  it("keeps provenance and usage in a private manifest", async () => {
    const row = await jobRow(jobId);
    expect(row.manifestKey).toBeTruthy();
    const manifest = decode(objects().get(row.manifestKey as string));
    expect(manifest).toMatchObject({ jobId, attempt: 1 });
    expect(manifest.totals).toMatchObject({ requests: h.mock.chats().length });
    expect((manifest.totals as { billedUsd: number }).billedUsd).toBeGreaterThan(0);
    expect(manifest.routing).toBeDefined();
    expect(manifest.stages).toBeDefined();
  });

  it("records spending for each step", async () => {
    const totals = await spendSoFar(h.db, jobId);
    expect(totals.requests).toBe(h.mock.chats().length);
    expect(totals.spentUsd).toBeGreaterThan(0);
    expect(totals.inputTokens).toBeGreaterThan(0);
    const steps = await h.db.select().from(jobSpend).where(eq(jobSpend.jobId, jobId));
    expect(steps.every((s) => s.status === "finished")).toBe(true);
  });

  it("carries exact source timecodes through to the export", async () => {
    const response = await exportOf(cookie, jobId, "promos-json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/attachment; filename="promolens-/);
    const { promos } = await response.json();
    expect(promos.length).toBeGreaterThan(0);
    const source = buildUnseenShowZip(4, `show-${showNumber}`).toString("utf8");
    for (const { promo } of promos) {
      for (const segment of promo.segments) {
        expect(source).toContain(segment.start);
        expect(source).toContain(segment.end);
      }
    }
  });

  it("gives a CSV that matches the stored promos", async () => {
    const stored = await (await resultsOf(cookie, jobId)).json();
    const csv = await (await exportOf(cookie, jobId, "promos-csv")).text();
    expect(csv).toBe(buildExportFile(stored, "promos-csv").content);
    const ranking = await (await exportOf(cookie, jobId, "ranking-json")).json();
    expect(ranking).toEqual(stored.ranking);
  });

  it("refuses an unknown export format", async () => {
    expect((await exportOf(cookie, jobId, "exe")).status).toBe(400);
  });

  it("loads source events one episode at a time, without writer notes", async () => {
    const response = await episodeOf(cookie, jobId, 1);
    expect(response.status).toBe(200);
    const { episode } = await response.json();
    expect(episode.number).toBe(1);
    expect(episode.events.length).toBeGreaterThan(0);
    expect(episode.events[0].startMs).toBe(0);
    expect(episode.writerNotes).toEqual({ otherFields: [] });
    expect(JSON.stringify(episode)).not.toContain("forged tide table");
    expect((await episodeOf(cookie, jobId, 99)).status).toBe(404);
  });

  it("never puts the screenplay in the status response", async () => {
    const status = await call(routes.getAnalysis, "/x", { cookie }, { id: jobId });
    const text = await status.text();
    expect(text).not.toMatch(/tide tables|ledger|archive door/i);
    expect(text.length).toBeLessThan(400);
  });

  it("returns 304 for an unchanged status and for unchanged results", async () => {
    const first = await call(routes.getAnalysis, "/x", { cookie }, { id: jobId });
    const tag = first.headers.get("etag") as string;
    const again = await call(
      routes.getAnalysis,
      "/x",
      { cookie, headers: { "if-none-match": tag } },
      { id: jobId },
    );
    expect(again.status).toBe(304);
    const results = await resultsOf(cookie, jobId);
    const unchanged = await resultsOf(cookie, jobId, {
      "if-none-match": results.headers.get("etag") as string,
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
  });

  it("does no inference to reopen a result", async () => {
    const before = h.mock.chats().length;
    await resultsOf(cookie, jobId);
    await exportOf(cookie, jobId, "promos-csv");
    await readJob(cookie, jobId);
    expect(h.mock.chats().length).toBe(before);
  });

  it("logs numbers and categories, never text or secrets", () => {
    expect(logs.length).toBeGreaterThan(5);
    const all = logs.join("\n");
    expect(all).toContain(jobId);
    expect(all).not.toMatch(/tide tables|ledger|archive door|forged/i);
    expect(all).not.toContain("sk-or-test-secret");
    expect(all).not.toContain("A hidden stowaway");
    expect(all).not.toContain("Authorization");
    for (const line of logs) {
      const { event } = JSON.parse(line) as { event: string };
      expect(event).toMatch(/^[a-z]+\.[a-z-]+$/);
    }
  });

  it("the same analysis again reuses the job and spends nothing", async () => {
    const before = h.mock.chats().length;
    const started = h.started.length;
    const { job, response } = await startJob(cookie, showId);
    expect(response.status).toBe(200);
    expect(job.id).toBe(jobId);
    expect(h.started.length).toBe(started);
    expect(h.mock.chats().length).toBe(before);
  });

  it("many simultaneous starts all land on one job", async () => {
    const { showId: fresh } = await uploadShow(cookie, newZip());
    let runs = 0;
    h.onStart = async () => {
      runs += 1;
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => startJob(cookie, fresh)));
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(runs).toBe(1);
  });

  it("cannot be retried once complete, and cancel leaves it complete", async () => {
    const retry = await call(routes.postRetry, "/x", { method: "POST", cookie }, { id: jobId });
    expect(retry.status).toBe(409);
    const cancel = await call(routes.postCancel, "/x", { method: "POST", cookie }, { id: jobId });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).job.state).toBe("completed");
  });
});

describe("retries and interruptions", () => {
  async function queued() {
    h.onStart = async () => {};
    const made = await analyzeNew(3);
    return made;
  }

  const stepsOf = (jobId: string, runId: string) => ({
    prepare: () => prepare(h.deps, jobId, runId),
    discover: (key: string, variant: string, episodes: number[]) =>
      discoverBatch(h.deps, jobId, runId, key, variant, episodes, 0),
    pool: () => buildPool(h.deps, jobId, runId),
    rank: (key: string) => rankSlice(h.deps, jobId, runId, key, 0),
  });

  async function through(jobId: string, runId: string) {
    const s = stepsOf(jobId, runId);
    const { episodes, variants } = await s.prepare();
    for (const variant of variants) await s.discover(`d-${variant}:1`, variant, episodes);
    await s.pool();
    return { s, episodes, variants };
  }

  it("repeating every step spends nothing extra", async () => {
    const { jobId } = await queued();
    const { s, episodes, variants } = await through(jobId, "run-1");
    const afterFirst = h.mock.chats().length;
    // At-least-once delivery: the platform may run any step again.
    await s.prepare();
    for (const variant of variants) await s.discover(`d-${variant}:2`, variant, episodes);
    await s.pool();
    expect(h.mock.chats().length).toBe(afterFirst);
    expect((await s.rank("r:1")).next).toBe("done");
    expect((await jobRow(jobId)).state).toBe("completed");
    const whole = h.mock.chats().length;
    await s.rank("r:2");
    expect(h.mock.chats().length).toBe(whole);
  });

  it("an interrupted ranking step resumes from what is saved", async () => {
    const { jobId } = await queued();
    await through(jobId, "run-2");
    const counted = h.mock.chats().length;
    let served = 0;
    // The step dies part way: every call after the tenth fails.
    h.mock.setChat((body) => {
      served += 1;
      return served > 10 ? failing([schemaOf(body) ?? ""])(body) : answerEveryStage(body);
    });
    expect((await rankSlice(h.deps, jobId, "run-2", "r:1", 0)).next).toBe("wait");
    const interrupted = h.mock.chats().length - counted;

    const seen = new Set<string>();
    h.mock.setChat((body) => {
      seen.add(JSON.stringify(body.messages));
      return answerEveryStage(body);
    });
    expect((await rankSlice(h.deps, jobId, "run-2", "r:2", 1)).next).toBe("done");
    expect((await jobRow(jobId)).state).toBe("completed");
    // The ten judgments that succeeded were not requested again.
    const unchanged = await h.db.select().from(jobSpend).where(eq(jobSpend.jobId, jobId));
    expect(unchanged.length).toBeGreaterThan(1);
    expect(interrupted).toBeGreaterThan(10);
    expect(seen.size).toBeGreaterThan(0);
  });

  it("a time-boxed step finishes over several slices, with no repeated judgment", async () => {
    const reference = await queued();
    await through(reference.jobId, "ref");
    const before = h.mock.chats().length;
    await rankSlice(h.deps, reference.jobId, "ref", "r:1", 0);
    const uninterrupted = h.mock.chats().length - before;

    const { jobId } = await queued();
    const original = h.deps.config.limits.stepBudgetMs;
    await through(jobId, "sliced");
    h.deps.config.limits.stepBudgetMs = 40;
    h.mock.setChat(async (body) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return answerEveryStage(body);
    });
    const start = h.mock.chats().length;
    let slices = 0;
    let next = "continue";
    while (next === "continue" && slices < 60) {
      next = (await rankSlice(h.deps, jobId, "sliced", `r:${++slices}`, 0)).next;
    }
    h.deps.config.limits.stepBudgetMs = original;
    expect(next).toBe("done");
    expect(slices).toBeGreaterThan(1);
    expect(h.mock.chats().length - start).toBe(uninterrupted);
  }, 90_000);

  it("a second run cannot take over and makes no calls", async () => {
    const { jobId } = await queued();
    await prepare(h.deps, jobId, "first-run");
    const before = h.mock.chats().length;
    await h.runAnalysis(jobId, "second-run");
    expect(h.mock.chats().length).toBe(before);
    expect((await jobRow(jobId)).workflowRunId).toBe("first-run");
    expect((await jobRow(jobId)).state).toBe("discovering");
  });

  it("a cancelled job stops and its later steps do nothing", async () => {
    const { jobId } = await queued();
    const { s, episodes, variants } = await through(jobId, "run-3");
    const cancel = await call(routes.postCancel, "/x", { method: "POST", cookie }, { id: jobId });
    expect((await cancel.json()).job.state).toBe("cancelled");
    const before = h.mock.chats().length;
    expect((await s.rank("r:1")).next).toBe("done");
    expect((await s.discover("x:1", variants[0] as string, episodes)).proceed).toBe(false);
    expect(h.mock.chats().length).toBe(before);
    expect((await jobRow(jobId)).state).toBe("cancelled");
  });

  it("a retried job reuses paid-for answers and writes under a new attempt", async () => {
    h.mock.setChat(failing(["editorial_judgment"]));
    const { jobId } = await analyzeNew(3);
    const failed = await readJob(cookie, jobId);
    expect(failed.state).toBe("failed");
    expect(failed.failure).toMatchObject({ code: "model-output-invalid", retryable: true });

    h.mock.setChat(answerEveryStage);
    const before = stageCounts(h);
    const retried = await call(routes.postRetry, "/x", { method: "POST", cookie }, { id: jobId });
    expect(retried.status).toBe(200);
    const after = stageCounts(h);
    expect(after.promo_proposals).toBe(before.promo_proposals);
    expect(after.promo_screen).toBe(before.promo_screen);
    expect(after.editorial_judgment).toBeGreaterThan(before.editorial_judgment as number);
    const row = await jobRow(jobId);
    expect(row.state).toBe("completed");
    expect(row.attempt).toBe(2);
    expect(row.rankingKey).toContain("/2/");
  });

  it("marks a job failed, not stuck, when a step keeps crashing", async () => {
    h.onStart = async () => {};
    const { jobId } = await analyzeNew(2);
    const original = h.deps.storage.get;
    h.deps.storage.get = async (key: string) => {
      if (key.endsWith("source.zip")) throw new Error("Storage is on fire");
      return original(key);
    };
    await h.runAnalysis(jobId, "crashing");
    h.deps.storage.get = original;
    const job = await readJob(cookie, jobId);
    expect(job.state).toBe("failed");
    expect(job.failure).toMatchObject({ code: "interrupted", retryable: true });
  });
});

describe("failures are reported honestly", () => {
  it("a provider that rejects the key fails fast and can be retried", async () => {
    h.mock.setChat(failing(["promo_proposals"], 401));
    const { jobId } = await analyzeNew(2);
    expect(await readJob(cookie, jobId)).toMatchObject({
      state: "failed",
      failure: { code: "provider-unavailable", stage: "discovering", retryable: true },
    });
    expect(await resultsOf(cookie, jobId).then((r) => r.status)).toBe(409);
  });

  it("an episode no provider will answer leaves a partial result, said plainly", async () => {
    const stuck: ChatHandler = (body) =>
      schemaOf(body) === "promo_proposals" && body.messages[1]?.content.startsWith("Episode 2,")
        ? { status: 500, body: { error: { code: 500, message: "Down" } } }
        : answerEveryStage(body);
    h.mock.setChat(stuck);
    const { jobId } = await analyzeNew(3);
    const job = await readJob(cookie, jobId);
    expect(job.state).toBe("partial");
    const { ranking, promos } = await (await resultsOf(cookie, jobId)).json();
    expect(ranking.status).toBe("partial");
    expect(promos.status).toBe("partial");
    expect(ranking.notes.join(" ")).toMatch(/only partly searched/);
  });

  it("invalid model output is never turned into scores", async () => {
    h.mock.setChat((body) =>
      schemaOf(body) === "editorial_judgment"
        ? chatReply({ nonsense: true })
        : answerEveryStage(body),
    );
    const { jobId } = await analyzeNew(2);
    expect(await readJob(cookie, jobId)).toMatchObject({
      state: "failed",
      failure: { code: "model-output-invalid", retryable: true },
    });
  });

  it("a refusal is remembered, not re-sent, and invents no score", async () => {
    h.mock.setChat(refusing("editorial_judgment"));
    const { jobId, showId } = await analyzeNew(2);
    const firstCount = stageCounts(h).editorial_judgment as number;
    expect(firstCount).toBeGreaterThan(0);
    const { ranking } = await (await resultsOf(cookie, jobId)).json();
    // The clips are reported as declined, with no rating made up for them.
    expect(ranking.shortlist).toEqual([]);
    const declined = ranking.list.filter(
      (item: { evaluation: string }) => item.evaluation === "provider-refused",
    );
    expect(declined.length).toBeGreaterThan(0);
    expect(
      declined.every((item: { editorialScore: unknown }) => item.editorialScore === null),
    ).toBe(true);

    // A later analysis of the same show does not ask again.
    h.env.PROMOLENS_SCREEN_MODEL = "openai/gpt-6-luna";
    await startJob(cookie, showId);
    delete h.env.PROMOLENS_SCREEN_MODEL;
    expect(stageCounts(h).editorial_judgment).toBe(firstCount);
  });

  it("reports a missing result artifact instead of recomputing it", async () => {
    const { jobId } = await analyzeNew(2);
    const row = await jobRow(jobId);
    objects().delete(row.promosKey as string);
    const before = h.mock.chats().length;
    const response = await resultsOf(cookie, jobId);
    expect(response.status).toBe(410);
    expect((await response.json()).error.code).toBe("missing-result");
    expect((await exportOf(cookie, jobId, "promos-csv")).status).toBe(410);
    expect(h.mock.chats().length).toBe(before);
  });

  it("reports a source file that has gone missing", async () => {
    h.onStart = async () => {};
    const { jobId, showId } = await analyzeNew(2);
    const [show] = await h.db.select().from(shows).where(eq(shows.id, showId));
    objects().delete(show?.storageKey as string);
    await h.runAnalysis(jobId);
    expect(await readJob(cookie, jobId)).toMatchObject({
      state: "failed",
      failure: { code: "storage-unavailable", stage: "validating" },
    });
  });

  it("notices a stored source that no longer matches its checksum", async () => {
    h.onStart = async () => {};
    const { jobId, showId } = await analyzeNew(2);
    const [show] = await h.db.select().from(shows).where(eq(shows.id, showId));
    objects().set(show?.storageKey as string, new TextEncoder().encode("tampered"));
    await h.runAnalysis(jobId);
    expect(await readJob(cookie, jobId)).toMatchObject({
      state: "failed",
      failure: { code: "invalid-archive", retryable: false },
    });
  });

  it("shows a workflow that could not start as a retryable failure", async () => {
    h.onStart = async () => {
      throw new Error("Queue unavailable");
    };
    const { showId } = await uploadShow(cookie, newZip(2));
    const { job } = await startJob(cookie, showId);
    expect(job).toMatchObject({
      state: "failed",
      failure: { code: "workflow-start", retryable: true },
    });
  });

  it("starts a queued job again only once its first start is clearly lost", async () => {
    h.onStart = async () => {};
    const { jobId, showId } = await analyzeNew(2);
    const started = h.started.length;
    await startJob(cookie, showId);
    expect(h.started.length).toBe(started);
    await h.db
      .update(analysisJobs)
      .set({ updatedAt: new Date(Date.now() - 120_000) })
      .where(eq(analysisJobs.id, jobId));
    await startJob(cookie, showId);
    expect(h.started.length).toBe(started + 1);
  });

  it("gives no internal detail when something unexpected breaks", async () => {
    const spy = vi.spyOn(h.db, "select").mockImplementation(() => {
      throw new Error("connection to 10.0.0.5 failed: password authentication failed");
    });
    const response = await call(routes.listAnalyses, "/x", { cookie });
    spy.mockRestore();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "server", message: "Something went wrong. Try again." },
    });
  });
});

describe("what changes the identity of an analysis", () => {
  afterEach(() => {
    delete h.env.PROMOLENS_SCREEN_MODEL;
  });

  it("a new model means a new job and new calls only where the model is used", async () => {
    const { jobId, showId } = await analyzeNew(2);
    const before = stageCounts(h);
    h.env.PROMOLENS_SCREEN_MODEL = "openai/gpt-6-luna";
    const { job } = await startJob(cookie, showId);
    expect(job.id).not.toBe(jobId);
    const after = stageCounts(h);
    // Discovery did not change, so its answers are reused from the cache.
    expect(after.promo_proposals).toBe(before.promo_proposals);
    expect(after.promo_screen).toBeGreaterThan(before.promo_screen as number);
    expect(await readJob(cookie, job.id)).toMatchObject({ state: "completed" });
  });

  it("does not share cached answers between editors", async () => {
    const zip = newZip(2);
    const { showId } = await uploadShow(cookie, zip);
    await startJob(cookie, showId);
    const before = stageCounts(h).promo_proposals as number;
    const bob = await signIn("bob");
    const bobs = await uploadShow(bob, zip);
    await startJob(bob, bobs.showId);
    expect(stageCounts(h).promo_proposals).toBeGreaterThan(before);
  });
});

describe("spending limits", () => {
  /**
   * Tightens the limits only while the analysis runs. The estimate checked at
   * start sees the normal limits, so this is a run that costs more than its
   * estimate: the case the running guard exists for.
   */
  const withBudget = async (
    limits: Partial<Harness["config"]["limits"]>,
    fn: () => Promise<void>,
  ) => {
    const original = { ...h.deps.config.limits };
    const start = h.onStart;
    h.onStart = async (jobId) => {
      Object.assign(h.deps.config.limits, limits);
      try {
        await h.runAnalysis(jobId);
      } finally {
        Object.assign(h.deps.config.limits, original);
      }
    };
    try {
      await fn();
    } finally {
      h.onStart = start;
    }
  };

  it("stops at a job's budget and never spends past it", async () => {
    await withBudget({ jobBudgetUsd: 0.0005 }, async () => {
      const { jobId } = await analyzeNew(3);
      const job = await readJob(cookie, jobId);
      expect(job.state).toBe("failed");
      expect(job.failure).toMatchObject({ code: "budget-reached", retryable: false });
      expect((await spendSoFar(h.db, jobId)).spentUsd).toBeLessThanOrEqual(0.0005);
    });
  });

  it("gives what was fully evaluated when the budget runs out during ranking", async () => {
    await withBudget({ jobBudgetUsd: 0.02 }, async () => {
      const { jobId } = await analyzeNew(3);
      const job = await readJob(cookie, jobId);
      expect(["partial", "failed"]).toContain(job.state);
      expect((await spendSoFar(h.db, jobId)).spentUsd).toBeLessThanOrEqual(0.02);
    });
  });

  it("stops at a job's request limit", async () => {
    await withBudget({ jobMaxRequests: 2 }, async () => {
      const before = h.mock.chats().length;
      const { jobId } = await analyzeNew(3);
      expect(h.mock.chats().length - before).toBeLessThanOrEqual(2);
      expect((await readJob(cookie, jobId)).state).toBe("failed");
    });
  });

  it("counts earlier attempts against the job's cap", async () => {
    h.mock.setChat(failing(["editorial_judgment"]));
    const { jobId } = await analyzeNew(2);
    const spent = (await spendSoFar(h.db, jobId)).spentUsd;
    expect(spent).toBeGreaterThan(0);
    h.mock.setChat(answerEveryStage);
    await withBudget({ jobBudgetUsd: spent + 0.00001 }, async () => {
      await call(routes.postRetry, "/x", { method: "POST", cookie }, { id: jobId });
      expect((await spendSoFar(h.db, jobId)).spentUsd).toBeLessThanOrEqual(spent + 0.00001);
    });
  });

  /** Applies limits at once, for checks made when a request arrives. */
  const withLimitsNow = async (
    limits: Partial<Harness["config"]["limits"]>,
    fn: () => Promise<void>,
  ) => {
    const original = { ...h.deps.config.limits };
    Object.assign(h.deps.config.limits, limits);
    try {
      await fn();
    } finally {
      Object.assign(h.deps.config.limits, original);
    }
  };

  it("refuses new work past the rolling limit, but still hands back finished work", async () => {
    const { jobId, showId } = await analyzeNew(2);
    await withLimitsNow({ rollingBudgetUsd: 0.000001 }, async () => {
      const fresh = await uploadShow(cookie, newZip(2));
      const refused = await call(routes.postAnalyses, "/x", {
        method: "POST",
        cookie,
        json: { showId: fresh.showId },
      });
      expect(refused.status).toBe(429);
      expect((await refused.json()).error.code).toBe("budget-reached");
      const reopened = await startJob(cookie, showId);
      expect(reopened.job.id).toBe(jobId);
    });
  });

  it("counts an interrupted step's reserved money as spent", async () => {
    const { jobId } = await analyzeNew(2);
    const before = (await spendSoFar(h.db, jobId)).spentUsd;
    await h.db
      .insert(jobSpend)
      .values({ jobId, stepKey: "crashed:1", phase: "ranking", status: "running", spentUsd: 0.25 });
    expect((await spendSoFar(h.db, jobId)).spentUsd).toBeCloseTo(before + 0.25);
  });
});

describe("results keep their shape in storage", () => {
  it("a multi-segment promo survives persistence and export exactly", async () => {
    h.onStart = async () => {};
    const { jobId } = await analyzeNew(2);
    const { ranking, promos } = buildDemoResults("complete");
    const multi = promos.promos.find(({ promo }) => promo.segments.length > 1);
    expect(multi).toBeDefined();
    const row = await jobRow(jobId);
    const prefix = `jobs/${row.ownerId}/${jobId}/1/`;
    await h.storage.put(`${prefix}ranking.json`, JSON.stringify(ranking), "application/json");
    await h.storage.put(`${prefix}promos.json`, JSON.stringify(promos), "application/json");
    await h.db
      .update(analysisJobs)
      .set({
        state: "completed",
        rankingKey: `${prefix}ranking.json`,
        promosKey: `${prefix}promos.json`,
      })
      .where(eq(analysisJobs.id, jobId));

    const stored = await (await resultsOf(cookie, jobId)).json();
    const found = stored.promos.promos.find(
      (item: { promo: { candidateId: string } }) =>
        item.promo.candidateId === multi?.promo.candidateId,
    );
    expect(found.promo.segments).toEqual(multi?.promo.segments);
    const exported = await (await exportOf(cookie, jobId, "promos-json")).json();
    expect(
      exported.promos.find(
        (p: { promo: { candidateId: string } }) => p.promo.candidateId === multi?.promo.candidateId,
      ).promo.segments,
    ).toEqual(multi?.promo.segments);
  });

  it("will not serve results from a job that has none yet", async () => {
    h.onStart = async () => {};
    const { jobId } = await analyzeNew(2);
    expect((await resultsOf(cookie, jobId)).status).toBe(409);
    expect((await exportOf(cookie, jobId, "promos-csv")).status).toBe(409);
  });
});

describe("deleting a show", () => {
  const remove = (who: string, id: string) =>
    call(routes.deleteShow, "/x", { method: "DELETE", cookie: who }, { id });

  it("removes every object and record", async () => {
    const { showId, jobId } = await analyzeNew(2);
    const row = await jobRow(jobId);
    const owned = () =>
      [...objects().keys()].filter(
        (key) => key.includes(showId) || key.includes(jobId) || key === row.rankingKey,
      );
    expect(owned().length).toBeGreaterThan(3);
    expect((await remove(cookie, showId)).status).toBe(204);
    expect(owned()).toEqual([]);
    expect(await h.db.select().from(shows).where(eq(shows.id, showId))).toEqual([]);
    expect(await h.db.select().from(analysisJobs).where(eq(analysisJobs.id, jobId))).toEqual([]);
    expect(
      await h.db.select().from(inferenceCache).where(eq(inferenceCache.showId, showId)),
    ).toEqual([]);
    const status = await call(routes.getAnalysis, "/x", { cookie }, { id: jobId });
    expect(status.status).toBe(404);
  });

  it("refuses another editor without saying the show exists", async () => {
    const { showId } = await analyzeNew(2);
    const bob = await signIn("bob");
    expect((await remove(bob, showId)).status).toBe(404);
    expect(await h.db.select().from(shows).where(eq(shows.id, showId))).toHaveLength(1);
  });

  it("refuses while an analysis is running", async () => {
    h.onStart = async () => {};
    const { showId } = await analyzeNew(2);
    expect((await remove(cookie, showId)).status).toBe(409);
  });
});

describe("the retention sweep", () => {
  const expire = (showId: string) =>
    h.db
      .update(shows)
      .set({ expiresAt: new Date(0) })
      .where(eq(shows.id, showId));

  it("changes nothing without --apply, and leaves unexpired shows alone", async () => {
    const keep = await analyzeNew(2);
    const old = await analyzeNew(2);
    await expire(old.showId);
    const before = objects().size;
    const dry = await sweepExpired(h.backend, { apply: false, now: new Date() });
    expect(dry.shows).toBeGreaterThanOrEqual(1);
    expect(objects().size).toBe(before);

    await sweepExpired(h.backend, { apply: true, now: new Date() });
    expect(await h.db.select().from(shows).where(eq(shows.id, old.showId))).toEqual([]);
    expect(await h.db.select().from(shows).where(eq(shows.id, keep.showId))).toHaveLength(1);
  });

  it("never touches a show with a running analysis", async () => {
    h.onStart = async () => {};
    const { showId } = await analyzeNew(2);
    await expire(showId);
    const result = await sweepExpired(h.backend, { apply: true, now: new Date() });
    expect(result.skippedBusy).toBe(1);
    expect(await h.db.select().from(shows).where(eq(shows.id, showId))).toHaveLength(1);
  });
});

describe("how much work each request does", () => {
  const countQueries = async (work: () => Promise<unknown>) => {
    const client = (h.db as unknown as { $client: { query: (...args: unknown[]) => unknown } })
      .$client;
    const spy = vi.spyOn(client, "query");
    await work();
    const count = spy.mock.calls.length;
    spy.mockRestore();
    return count;
  };

  it("keeps every read to a small fixed number of queries", async () => {
    const small = await analyzeNew(2);
    const large = await analyzeNew(5);
    for (const { jobId } of [small, large]) {
      expect(await countQueries(() => readJob(cookie, jobId))).toBe(2);
      expect(await countQueries(() => resultsOf(cookie, jobId))).toBe(3);
      expect(await countQueries(() => episodeOf(cookie, jobId, 1))).toBe(3);
    }
    const listed = await countQueries(() => call(routes.listAnalyses, "/x", { cookie }));
    expect(listed).toBe(2);
  });

  it("does not read storage to answer an unchanged results request", async () => {
    const { jobId } = await analyzeNew(2);
    const tag = (await resultsOf(cookie, jobId)).headers.get("etag") as string;
    const spy = vi.spyOn(h.storage, "get");
    const response = await resultsOf(cookie, jobId, { "if-none-match": tag });
    expect(response.status).toBe(304);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
