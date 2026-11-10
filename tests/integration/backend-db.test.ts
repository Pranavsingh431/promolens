import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  JOB_STATES,
  LEGAL_TRANSITIONS,
  canTransition,
  type JobState,
} from "../../src/domain/analysis-job";
import { analysisJobs, editors, jobEvents, jobSpend, shows } from "../../src/server/db/schema";
import { openDatabase, type Database } from "../../src/server/db/client";
import {
  activeJob,
  claimJob,
  createOrReuseJob,
  failJob,
  pollDelayMs,
  requeueJob,
  rollingSpend,
  spendSoFar,
  toAnalysisJob,
  transitionJob,
} from "../../src/server/jobs";

let db: Database;
let ownerId: string;
let otherOwner: string;
let showId: string;
let counter = 0;

const hex = (seed: number) => seed.toString(16).padStart(64, "0");

async function addShow(owner = ownerId) {
  counter += 1;
  const [row] = await db
    .insert(shows)
    .values({
      ownerId: owner,
      title: "Made-up show",
      fileName: "show.zip",
      archiveSha256: hex(counter),
      contentSha256: hex(counter),
      sizeBytes: 100,
      storageKey: `uploads/test/${counter}`,
      episodeCount: 3,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .returning();
  return row as typeof shows.$inferSelect;
}

const newJob = async (key = `identity-${++counter}`, show = showId) =>
  (
    await createOrReuseJob(db, {
      ownerId,
      showId: show,
      identityKey: key,
      pipelineVersion: "test",
    })
  ).job;

async function jobInState(state: JobState) {
  const job = await newJob();
  await db.update(analysisJobs).set({ state }).where(eq(analysisJobs.id, job.id));
  return job.id;
}

beforeAll(async () => {
  db = await openDatabase("pglite:memory");
  const made = await db
    .insert(editors)
    .values([{ name: "a" }, { name: "b" }])
    .returning();
  ownerId = made[0]?.id as string;
  otherOwner = made[1]?.id as string;
  showId = (await addShow()).id;
});

describe("migrations", () => {
  const tables = async () => {
    const result = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    return (result as unknown as { rows: Array<{ table_name: string }> }).rows.map(
      (row) => row.table_name,
    );
  };

  it("create every table on an empty database", async () => {
    expect(await tables()).toEqual(
      expect.arrayContaining([
        "editors",
        "sessions",
        "uploads",
        "shows",
        "analysis_jobs",
        "job_events",
        "job_spend",
        "inference_cache",
        "rate_limits",
      ]),
    );
  });

  it("create the indexes the application relies on", async () => {
    const result = await db.execute(
      sql`select indexname, indexdef from pg_indexes where schemaname = 'public'`,
    );
    const defs = (result as unknown as { rows: Array<{ indexdef: string }> }).rows.map(
      (r) => r.indexdef,
    );
    expect(defs.some((d) => /UNIQUE/.test(d) && /identity_key/.test(d) && /WHERE/.test(d))).toBe(
      true,
    );
    expect(defs.some((d) => /UNIQUE/.test(d) && /content_sha256/.test(d))).toBe(true);
  });

  it("can run twice without harm", async () => {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await expect(migrate(db as never, { migrationsFolder: "drizzle" })).resolves.toBeUndefined();
  });
});

describe("constraints", () => {
  it("refuses a second show with the same content for one owner", async () => {
    const show = await addShow();
    await expect(
      db.insert(shows).values({ ...show, id: undefined as never, storageKey: "uploads/other" }),
    ).rejects.toThrow();
  });

  it("allows the same content for a different owner", async () => {
    const show = await addShow();
    await expect(
      db.insert(shows).values({
        ...show,
        id: undefined as never,
        ownerId: otherOwner,
        storageKey: "uploads/other-owner",
      }),
    ).resolves.toBeDefined();
  });

  it("refuses a job for a show that does not exist", async () => {
    await expect(
      db.insert(analysisJobs).values({
        ownerId,
        showId: "00000000-0000-4000-8000-000000000000",
        identityKey: "x",
        pipelineVersion: "t",
        facts: {},
      }),
    ).rejects.toThrow();
  });

  it("removes jobs, audit rows, and spend with their show", async () => {
    const show = await addShow();
    const job = await newJob(`cascade-${counter}`, show.id);
    await db.insert(jobSpend).values({ jobId: job.id, stepKey: "s", phase: "ranking" });
    await db.delete(shows).where(eq(shows.id, show.id));
    expect(await db.select().from(analysisJobs).where(eq(analysisJobs.id, job.id))).toEqual([]);
    expect(await db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id))).toEqual([]);
    expect(await db.select().from(jobSpend).where(eq(jobSpend.jobId, job.id))).toEqual([]);
  });
});

describe("one logical analysis has one job", () => {
  it("returns the same job for parallel requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        createOrReuseJob(db, {
          ownerId,
          showId,
          identityKey: "parallel",
          pipelineVersion: "t",
        }),
      ),
    );
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it("reuses a completed job", async () => {
    const first = await newJob("finished");
    await db.update(analysisJobs).set({ state: "completed" }).where(eq(analysisJobs.id, first.id));
    const again = await createOrReuseJob(db, {
      ownerId,
      showId,
      identityKey: "finished",
      pipelineVersion: "t",
    });
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(first.id);
  });

  it("starts fresh after a failed or cancelled job", async () => {
    for (const state of ["failed", "cancelled"] as const) {
      const first = await newJob(`retired-${state}`);
      await db.update(analysisJobs).set({ state }).where(eq(analysisJobs.id, first.id));
      const again = await createOrReuseJob(db, {
        ownerId,
        showId,
        identityKey: `retired-${state}`,
        pipelineVersion: "t",
      });
      expect(again.created).toBe(true);
    }
  });

  it("will not retry an old job while a new one holds the identity", async () => {
    const old = await newJob("held");
    await failJob(db, old.id, "internal", "ranking", true);
    await newJob("held");
    expect(await requeueJob(db, old.id)).toEqual({ job: null, conflict: true });
  });
});

describe("the job state machine", () => {
  const pairs = JOB_STATES.flatMap((from) => JOB_STATES.map((to) => [from, to] as const));

  it.each(pairs)("%s to %s is allowed only if listed", async (from, to) => {
    const id = await jobInState(from);
    const moved = await transitionJob(db, id, to);
    expect(moved !== null).toBe(LEGAL_TRANSITIONS[from].includes(to));
    const [row] = await db.select().from(analysisJobs).where(eq(analysisJobs.id, id));
    expect(row?.state).toBe(canTransition(from, to) ? to : from);
  });

  it("never moves a completed job", () => {
    expect(LEGAL_TRANSITIONS.completed).toEqual([]);
  });

  it("audits each move without any detail beyond a category", async () => {
    const id = await jobInState("queued");
    await transitionJob(db, id, "validating");
    await failJob(db, id, "invalid-archive", "validating", false);
    const events = await db.select().from(jobEvents).where(eq(jobEvents.jobId, id));
    expect(events.map((e) => [e.fromState, e.toState])).toEqual([
      [null, "queued"],
      ["queued", "validating"],
      ["validating", "failed"],
    ]);
    expect(events.at(-1)?.detail).toBe("invalid-archive");
  });

  it("settles two simultaneous moves on one winner", async () => {
    const id = await jobInState("queued");
    const moves = await Promise.all([
      transitionJob(db, id, "validating"),
      transitionJob(db, id, "cancelled"),
      transitionJob(db, id, "failed"),
    ]);
    const events = await db.select().from(jobEvents).where(eq(jobEvents.jobId, id));
    expect(moves.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    // Every recorded move starts from the state the previous one left.
    for (let i = 2; i < events.length; i++) {
      expect(events[i]?.fromState).toBe(events[i - 1]?.toState);
    }
  });

  it("bumps the revision on every change, so status checks can tell", async () => {
    const id = await jobInState("queued");
    const before = (await db.select().from(analysisJobs).where(eq(analysisJobs.id, id)))[0];
    await transitionJob(db, id, "validating");
    const after = (await db.select().from(analysisJobs).where(eq(analysisJobs.id, id)))[0];
    expect(after?.revision).toBe((before?.revision ?? 0) + 1);
  });
});

describe("only one workflow run may work on a job", () => {
  it("gives the job to the first run and refuses the second", async () => {
    const job = await newJob();
    expect(await claimJob(db, job.id, "run-a")).not.toBeNull();
    expect(await claimJob(db, job.id, "run-b")).toBeNull();
    expect(await claimJob(db, job.id, "run-a")).not.toBeNull();
    expect(await activeJob(db, job.id, "run-b")).toBeNull();
  });

  it("will not hand out a job that has finished", async () => {
    const id = await jobInState("completed");
    expect(await claimJob(db, id, "run-a")).toBeNull();
  });

  it("clears the run on retry so a new run can claim it", async () => {
    const job = await newJob();
    await claimJob(db, job.id, "run-a");
    await failJob(db, job.id, "internal", "ranking", true);
    const { job: queued } = await requeueJob(db, job.id);
    expect(queued?.attempt).toBe(2);
    expect(queued?.workflowRunId).toBeNull();
    expect(queued?.failureCode).toBeNull();
    expect(await claimJob(db, job.id, "run-b")).not.toBeNull();
  });
});

describe("what the browser is told", () => {
  it("hides failure details unless the job failed", async () => {
    const job = await newJob();
    expect(toAnalysisJob(job, { fileName: "a.zip" }, new Date()).failure).toBeNull();
    const failed = await failJob(db, job.id, "budget-reached", "ranking", false);
    expect(toAnalysisJob(failed as never, { fileName: "a.zip" }, new Date()).failure).toEqual({
      code: "budget-reached",
      stage: "ranking",
      retryable: false,
    });
  });

  it("asks less often as an analysis ages", () => {
    const createdAt = new Date(1_000_000);
    const at = (seconds: number) => new Date(createdAt.getTime() + seconds * 1000);
    expect(pollDelayMs({ createdAt }, at(10))).toBe(2_000);
    expect(pollDelayMs({ createdAt }, at(120))).toBe(4_000);
    expect(pollDelayMs({ createdAt }, at(900))).toBe(8_000);
  });
});

describe("spending records", () => {
  it("adds up every step, including interrupted ones", async () => {
    const job = await newJob();
    await db.insert(jobSpend).values([
      { jobId: job.id, stepKey: "a:1", phase: "ranking", status: "running", spentUsd: 0.5 },
      {
        jobId: job.id,
        stepKey: "a:2",
        phase: "ranking",
        status: "finished",
        spentUsd: 0.25,
        requests: 4,
      },
    ]);
    const totals = await spendSoFar(db, job.id);
    expect(totals.spentUsd).toBeCloseTo(0.75);
    expect(totals.requests).toBe(4);
    expect(await rollingSpend(db, ownerId, new Date())).toBeGreaterThanOrEqual(0.75);
    expect(await rollingSpend(db, otherOwner, new Date())).toBe(0);
  });
});
