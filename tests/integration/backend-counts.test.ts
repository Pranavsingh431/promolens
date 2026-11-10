import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as postMore } from "../../src/app/api/analyses/[id]/more/route";
import { POST as postAnalyses } from "../../src/app/api/analyses/route";
import {
  analysisJobs,
  inferenceCache,
  jobEvents,
  jobSpend,
  rateLimits,
} from "../../src/server/db/schema";
import { exportOf, readJob, resultsOf, signIn, uploadShow } from "../support/backend-api";
import { answerVaried } from "../support/backend-model";
import { call, createHarness, stageCounts, type Harness } from "../support/backend-harness";
import { buildUnseenShowZip } from "../support/unseen-show";

/**
 * The requested number of promos drives real pipeline work. Everything runs
 * in-process against the mock model, with judgments that differ per clip.
 */

let h: Harness;
let cookie = "";
let showId = "";

beforeAll(async () => {
  h = await createHarness();
  h.mock.setChat(answerVaried);
  cookie = await signIn("alice");
  ({ showId } = await uploadShow(cookie, buildUnseenShowZip(12, "count-show", true), "count.zip"));
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.db.delete(rateLimits);
});

/** Each measured run starts with nothing cached, as a first analysis of a show would. */
async function forgetEverything() {
  for (const table of [jobSpend, jobEvents, analysisJobs, inferenceCache]) await h.db.delete(table);
}

async function analyze(count: unknown) {
  const before = h.mock.chats().length;
  const stagesBefore = stageCounts(h);
  const response = await call(postAnalyses, "/api/analyses", {
    method: "POST",
    cookie,
    json: { showId, count },
  });
  const body = (await response.json()) as { job?: { id: string }; error?: { code: string } };
  const calls = h.mock.chats().length - before;
  const stages = Object.fromEntries(
    Object.entries(stageCounts(h)).map(([k, v]) => [k, v - (stagesBefore[k] ?? 0)]),
  );
  return { response, body, calls, stages };
}

async function shortlistOf(jobId: string) {
  const results = (await (await resultsOf(cookie, jobId)).json()) as {
    ranking: {
      shortlist: Array<{ candidateId: string; clipKey: string }>;
      counts: Record<string, number>;
      notes: string[];
    };
  };
  return results.ranking;
}

describe("asking for a number of promos", () => {
  it("refuses counts that are not whole numbers from 1 to the ceiling", async () => {
    for (const bad of [0, -1, 2.5, 501, "ten"]) {
      const { response } = await analyze(bad);
      expect(response.status).toBe(400);
    }
  });

  it("keeps the request with the job and returns no more than it", async () => {
    await forgetEverything();
    const { body } = await analyze(3);
    const job = await readJob(cookie, body.job?.id as string);
    expect(job.state).toBe("completed");
    expect(job.facts).toMatchObject({ requested: 3, returned: 3 });
    expect((job.facts as { elapsedMs?: number }).elapsedMs).toBeGreaterThanOrEqual(0);
    const ranking = await shortlistOf(job.id);
    expect(ranking.shortlist).toHaveLength(3);
    expect(ranking.counts.requested).toBe(3);
    // No promo appears twice.
    expect(new Set(ranking.shortlist.map((p) => p.clipKey)).size).toBe(3);
  });

  it("does fewer paid evaluations for fewer promos, measured", async () => {
    await forgetEverything();
    const small = await analyze(1);
    await forgetEverything();
    const large = await analyze(30);
    expect(small.stages.promo_proposals).toBe(large.stages.promo_proposals);
    expect(small.stages.promo_screen).toBe(large.stages.promo_screen);
    expect(small.stages.editorial_judgment ?? 0).toBeLessThan(large.stages.editorial_judgment ?? 0);
    expect(small.stages.pairwise_judgment ?? 0).toBeLessThan(large.stages.pairwise_judgment ?? 0);
    expect(small.calls).toBeLessThan(large.calls);
  });

  it("returns what qualifies when fewer clips pass than were asked for, and says so", async () => {
    await forgetEverything();
    const { body } = await analyze(500);
    const job = await readJob(cookie, body.job?.id as string);
    expect(job.state).toBe("completed");
    const ranking = await shortlistOf(job.id);
    expect(ranking.shortlist.length).toBeGreaterThan(0);
    expect(ranking.shortlist.length).toBeLessThan(500);
    expect(ranking.counts.assessed).toBeLessThanOrEqual(ranking.counts.poolInScope as number);
    expect(ranking.notes.join(" ")).toMatch(/500 promos were requested/);
    expect(new Set(ranking.shortlist.map((p) => p.clipKey)).size).toBe(ranking.shortlist.length);
    // The export holds only clips that passed: the recommended ones are exactly the shortlist.
    const exported = (await (await exportOf(cookie, job.id, "promos-json")).json()) as {
      promos: Array<{ shortlistRank: number | null }>;
    };
    expect(exported.promos.filter((p) => p.shortlistRank !== null)).toHaveLength(
      ranking.shortlist.length,
    );
  });

  it("treats each count as its own analysis and hands back a finished one free", async () => {
    await forgetEverything();
    const first = await analyze(4);
    const again = await analyze(4);
    expect(again.body.job?.id).toBe(first.body.job?.id);
    expect(again.calls).toBe(0);
    const other = await analyze(6);
    expect(other.body.job?.id).not.toBe(first.body.job?.id);
  });

  it("asks an earlier analysis for more, reusing every judgment already made", async () => {
    await forgetEverything();
    const first = await analyze(5);
    const before = h.mock.chats().length;
    const stagesBefore = stageCounts(h);
    const response = await call(
      postMore,
      `/api/analyses/${first.body.job?.id}/more`,
      { method: "POST", cookie, json: { count: 15 } },
      { id: first.body.job?.id as string },
    );
    expect(response.status).toBe(201);
    const { job } = (await response.json()) as { job: { id: string } };
    const more = { calls: h.mock.chats().length - before, stages: stageCounts(h) };
    expect(more.stages.promo_proposals).toBe(stagesBefore.promo_proposals);
    expect(more.stages.promo_screen).toBe(stagesBefore.promo_screen);
    const finished = await readJob(cookie, job.id);
    expect(finished.facts).toMatchObject({ requested: 15 });

    await forgetEverything();
    const fresh = await analyze(15);
    expect(more.calls).toBeLessThan(fresh.calls);
  });

  it("refuses before spending when even the cheapest outcome is over the job budget", async () => {
    const limits = h.config.limits as { jobBudgetUsd: number };
    const budget = limits.jobBudgetUsd;
    limits.jobBudgetUsd = 0.001;
    try {
      await forgetEverything();
      const { response, body, calls } = await analyze(20);
      expect(response.status).toBe(422);
      expect(body.error?.code).toBe("over-budget");
      expect(calls).toBe(0);
    } finally {
      limits.jobBudgetUsd = budget;
    }
  });
});
