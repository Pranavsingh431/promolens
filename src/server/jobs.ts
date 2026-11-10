import { and, desc, eq, gt, isNull, notInArray, or, sql, sum } from "drizzle-orm";

import {
  TERMINAL_STATES,
  canTransition,
  type AnalysisJob,
  type JobFacts,
  type JobFailureCode,
  type JobStage,
  type JobState,
  type JobSummary,
} from "../domain/analysis-job.ts";
import type { Database } from "./db/client.ts";
import { analysisJobs, jobEvents, jobSpend, shows } from "./db/schema.ts";

/** All job state changes go through here, so the legal moves are enforced in one place. */

export type JobRow = typeof analysisJobs.$inferSelect;
export type ShowRow = typeof shows.$inferSelect;

const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (error: unknown) => {
  const seen = new Set<unknown>();
  for (
    let e = error as { code?: string; cause?: unknown } | undefined;
    e && !seen.has(e);
    e = e.cause as typeof e
  ) {
    seen.add(e);
    if (e.code === UNIQUE_VIOLATION) return true;
  }
  return false;
};

/**
 * Finds or creates the job for one logical analysis. The database's partial
 * unique index decides the winner, so parallel requests get the same job.
 */
export async function createOrReuseJob(
  db: Database,
  input: { ownerId: string; showId: string; identityKey: string; pipelineVersion: string },
): Promise<{ job: JobRow; created: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(analysisJobs)
        .values({ ...input, facts: {} })
        .onConflictDoNothing()
        .returning();
      if (row) {
        await tx
          .insert(jobEvents)
          .values({ jobId: row.id, attempt: row.attempt, fromState: null, toState: "queued" });
      }
      return row;
    });
    if (created) return { job: created, created: true };
    const [existing] = await db
      .select()
      .from(analysisJobs)
      .where(
        and(
          eq(analysisJobs.ownerId, input.ownerId),
          eq(analysisJobs.identityKey, input.identityKey),
          notInArray(analysisJobs.state, ["failed", "cancelled"]),
        ),
      )
      .limit(1);
    if (existing) return { job: existing, created: false };
    // The other job failed between the two statements. Try again.
  }
  throw new Error("Could not settle on a job for this analysis.");
}

export async function transitionJob(
  db: Database,
  jobId: string,
  to: JobState,
  patch: Partial<typeof analysisJobs.$inferInsert> = {},
  detail?: string,
): Promise<JobRow | null> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ state: analysisJobs.state, attempt: analysisJobs.attempt })
      .from(analysisJobs)
      .where(eq(analysisJobs.id, jobId))
      .for("update");
    if (!before || !canTransition(before.state, to)) return null;
    const [row] = await tx
      .update(analysisJobs)
      .set({
        ...patch,
        state: to,
        revision: sql`${analysisJobs.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(analysisJobs.id, jobId))
      .returning();
    await tx.insert(jobEvents).values({
      jobId,
      attempt: row?.attempt ?? before.attempt,
      fromState: before.state,
      toState: to,
      detail: detail ?? null,
    });
    return row ?? null;
  });
}

const notFinished = notInArray(analysisJobs.state, [...TERMINAL_STATES]);

/** Gives one workflow run the exclusive right to work on a job. A duplicate run gets null. */
export async function claimJob(db: Database, jobId: string, runId: string): Promise<JobRow | null> {
  const [row] = await db
    .update(analysisJobs)
    .set({ workflowRunId: runId })
    .where(
      and(
        eq(analysisJobs.id, jobId),
        notFinished,
        or(isNull(analysisJobs.workflowRunId), eq(analysisJobs.workflowRunId, runId)),
      ),
    )
    .returning();
  return row ?? null;
}

/** The job, only if it is still live and still belongs to this run. */
export async function activeJob(
  db: Database,
  jobId: string,
  runId: string,
): Promise<JobRow | null> {
  const [row] = await db
    .select()
    .from(analysisJobs)
    .where(and(eq(analysisJobs.id, jobId), eq(analysisJobs.workflowRunId, runId), notFinished))
    .limit(1);
  return row ?? null;
}

export async function updateFacts(
  db: Database,
  jobId: string,
  runId: string,
  facts: JobFacts,
): Promise<void> {
  await db
    .update(analysisJobs)
    .set({ facts, revision: sql`${analysisJobs.revision} + 1`, updatedAt: new Date() })
    .where(and(eq(analysisJobs.id, jobId), eq(analysisJobs.workflowRunId, runId), notFinished));
}

export async function getShowById(db: Database, showId: string): Promise<ShowRow | null> {
  const [row] = await db.select().from(shows).where(eq(shows.id, showId)).limit(1);
  return row ?? null;
}

export async function findOwnedShow(
  db: Database,
  ownerId: string,
  showId: string,
): Promise<ShowRow | null> {
  const [row] = await db
    .select()
    .from(shows)
    .where(and(eq(shows.id, showId), eq(shows.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/** A job and its show, only for the owner. Anyone else gets exactly what a missing job gets. */
export async function findOwnedJob(
  db: Database,
  ownerId: string,
  jobId: string,
): Promise<{ job: JobRow; show: ShowRow } | null> {
  const [row] = await db
    .select({ job: analysisJobs, show: shows })
    .from(analysisJobs)
    .innerJoin(shows, eq(shows.id, analysisJobs.showId))
    .where(and(eq(analysisJobs.id, jobId), eq(analysisJobs.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

const STAGE_OF: Partial<Record<JobState, JobStage>> = {
  uploading: "uploading",
  validating: "validating",
  parsing: "parsing",
  discovering: "discovering",
  evaluating: "evaluating",
  ranking: "ranking",
};

export const stageOf = (state: JobState): JobStage => STAGE_OF[state] ?? "validating";

/** How often the browser should ask. Long analyses are asked about less often. */
export function pollDelayMs(job: Pick<JobRow, "createdAt">, now: Date): number {
  const age = now.getTime() - job.createdAt.getTime();
  if (age < 60_000) return 2_000;
  if (age < 300_000) return 4_000;
  return 8_000;
}

export function toAnalysisJob(
  job: JobRow,
  show: Pick<ShowRow, "fileName">,
  now: Date,
): AnalysisJob {
  return {
    id: job.id,
    fileName: show.fileName,
    state: job.state,
    facts: job.facts,
    failure:
      job.state === "failed" && job.failureCode && job.failureStage
        ? {
            code: job.failureCode,
            stage: job.failureStage,
            retryable: Boolean(job.failureRetryable),
          }
        : null,
    canCancel: !TERMINAL_STATES.includes(job.state),
    pollAfterMs: pollDelayMs(job, now),
  };
}

export async function failJob(
  db: Database,
  jobId: string,
  code: JobFailureCode,
  stage: JobStage,
  retryable: boolean,
): Promise<JobRow | null> {
  return transitionJob(
    db,
    jobId,
    "failed",
    { failureCode: code, failureStage: stage, failureRetryable: retryable, finishedAt: new Date() },
    code,
  );
}

/** Puts a stopped job back in the queue as a new attempt. Earlier valid work stays in the cache. */
export async function requeueJob(
  db: Database,
  jobId: string,
): Promise<{ job: JobRow | null; conflict: boolean }> {
  try {
    const job = await transitionJob(
      db,
      jobId,
      "queued",
      {
        attempt: sql`${analysisJobs.attempt} + 1` as unknown as number,
        workflowRunId: null,
        failureCode: null,
        failureStage: null,
        failureRetryable: null,
        finishedAt: null,
      },
      "retry",
    );
    return { job, conflict: false };
  } catch (error) {
    if (isUniqueViolation(error)) return { job: null, conflict: true };
    throw error;
  }
}

export async function listJobs(
  db: Database,
  ownerId: string,
  now: Date,
  limit = 20,
): Promise<JobSummary[]> {
  const rows = await db
    .select({ job: analysisJobs, show: shows })
    .from(analysisJobs)
    .innerJoin(shows, eq(shows.id, analysisJobs.showId))
    .where(eq(analysisJobs.ownerId, ownerId))
    .orderBy(desc(analysisJobs.createdAt))
    .limit(limit);
  return rows.map(({ job, show }) => ({
    job: toAnalysisJob(job, show, now),
    showId: show.id,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  }));
}

/** The job already holding this logical analysis, if there is one. */
export async function findJobByIdentity(
  db: Database,
  ownerId: string,
  identityKey: string,
): Promise<JobRow | null> {
  const [row] = await db
    .select()
    .from(analysisJobs)
    .where(
      and(
        eq(analysisJobs.ownerId, ownerId),
        eq(analysisJobs.identityKey, identityKey),
        notInArray(analysisJobs.state, ["failed", "cancelled"]),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function liveJobsForShow(db: Database, showId: string): Promise<number> {
  const rows = await db
    .select({ id: analysisJobs.id })
    .from(analysisJobs)
    .where(and(eq(analysisJobs.showId, showId), notFinished));
  return rows.length;
}

export async function spendSoFar(db: Database, jobId: string) {
  const [row] = await db
    .select({
      spentUsd: sum(jobSpend.spentUsd).mapWith(Number),
      billedUsd: sum(jobSpend.billedUsd).mapWith(Number),
      estimatedUsd: sum(jobSpend.estimatedUsd).mapWith(Number),
      requests: sum(jobSpend.requests).mapWith(Number),
      liveJudgments: sum(jobSpend.liveJudgments).mapWith(Number),
      failedJudgments: sum(jobSpend.failedJudgments).mapWith(Number),
      refusedJudgments: sum(jobSpend.refusedJudgments).mapWith(Number),
      inputTokens: sum(jobSpend.inputTokens).mapWith(Number),
      outputTokens: sum(jobSpend.outputTokens).mapWith(Number),
    })
    .from(jobSpend)
    .where(eq(jobSpend.jobId, jobId));
  return {
    spentUsd: row?.spentUsd ?? 0,
    billedUsd: row?.billedUsd ?? 0,
    estimatedUsd: row?.estimatedUsd ?? 0,
    requests: row?.requests ?? 0,
    liveJudgments: row?.liveJudgments ?? 0,
    failedJudgments: row?.failedJudgments ?? 0,
    refusedJudgments: row?.refusedJudgments ?? 0,
    inputTokens: row?.inputTokens ?? 0,
    outputTokens: row?.outputTokens ?? 0,
  };
}

/** Everything an editor has spent in the last 30 days, for the rolling cap. */
export async function rollingSpend(db: Database, ownerId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [row] = await db
    .select({ spent: sum(jobSpend.spentUsd).mapWith(Number) })
    .from(jobSpend)
    .innerJoin(analysisJobs, eq(analysisJobs.id, jobSpend.jobId))
    .where(and(eq(analysisJobs.ownerId, ownerId), gt(jobSpend.updatedAt, since)));
  return row?.spent ?? 0;
}
