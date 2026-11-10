import { episodeSchema, type Episode } from "../domain/screenplay/schema.ts";
import { estimateAnalysis } from "../domain/estimate.ts";
import { DEFAULT_PROMOS } from "../domain/ranking/plan.ts";
import { workProfile } from "./analysis/calibration.ts";
import { analysisIdentity, pipelineIdentity } from "./analysis/identity.ts";
import { episodeKey } from "./analysis/pipeline.ts";
import { ApiError } from "./api-error.ts";
import type { Editor } from "./auth.ts";
import type { Backend } from "./backend.ts";
import {
  createOrReuseJob,
  failJob,
  findJobByIdentity,
  findOwnedJob,
  findOwnedShow,
  requeueJob,
  rollingSpend,
  transitionJob,
  type JobRow,
  type ShowRow,
} from "./jobs.ts";
import { logEvent } from "./log.ts";

/** The rules behind the analysis endpoints. Every function checks ownership first. */

/** A queued job with no run after this long lost its start and may be started again. */
const LOST_START_MS = 60_000;

async function launch(backend: Backend, job: JobRow): Promise<JobRow> {
  try {
    await backend.startRun(job.id);
    logEvent("job.queued", { jobId: job.id, attempt: job.attempt });
    return job;
  } catch {
    logEvent("job.failed", { jobId: job.id, errorCategory: "workflow-start" });
    return (await failJob(backend.db, job.id, "workflow-start", "validating", true)) ?? job;
  }
}

async function assertRollingBudget(backend: Backend, ownerId: string): Promise<void> {
  const spent = await rollingSpend(backend.db, ownerId, new Date());
  if (spent >= backend.config.limits.rollingBudgetUsd) {
    throw new ApiError(
      429,
      "budget-reached",
      "The spending limit for this period has been reached. Try again later.",
    );
  }
}

/**
 * Refuses a request whose cheapest likely outcome is already over the job's
 * spending cap. The cap still stops anything that runs over; this only says so
 * before any money is spent.
 */
function assertWithinJobBudget(backend: Backend, show: ShowRow, requested: number): void {
  const estimate = estimateAnalysis(workProfile(backend.config, backend.env), {
    episodes: show.episodeCount,
    requested,
  });
  if (estimate.overBudget === "yes") {
    throw new ApiError(
      422,
      "over-budget",
      `${requested} promos for this show would cost more than the limit for one analysis. Ask for fewer promos.`,
    );
  }
}

export async function startAnalysis(
  backend: Backend,
  editor: Editor,
  showId: string,
  requested: number = DEFAULT_PROMOS,
): Promise<{ job: JobRow; show: ShowRow; created: boolean }> {
  const { db, env } = backend;
  const show = await findOwnedShow(db, editor.id, showId);
  if (!show) throw new ApiError(404, "not-found", "That was not found.");

  const pipeline = pipelineIdentity(env, requested);
  const identityKey = analysisIdentity(editor.id, show.contentSha256, pipeline.hash);
  const existing = await findJobByIdentity(db, editor.id, identityKey);
  // A finished or running analysis is handed back free, whatever the budget says.
  if (!existing) {
    assertWithinJobBudget(backend, show, requested);
    await assertRollingBudget(backend, editor.id);
  }

  const { job, created } = existing
    ? { job: existing, created: false }
    : await createOrReuseJob(db, {
        ownerId: editor.id,
        showId: show.id,
        identityKey,
        pipelineVersion: pipeline.version,
        facts: { requested },
      });
  if (created) return { job: await launch(backend, job), show, created };

  const lostStart =
    job.state === "queued" &&
    !job.workflowRunId &&
    Date.now() - job.updatedAt.getTime() > LOST_START_MS;
  return { job: lostStart ? await launch(backend, job) : job, show, created: false };
}

export async function requireOwnedJob(backend: Backend, editor: Editor, jobId: string) {
  const found = await findOwnedJob(backend.db, editor.id, jobId);
  if (!found) throw new ApiError(404, "not-found", "That was not found.");
  return found;
}

export async function cancelAnalysis(backend: Backend, editor: Editor, jobId: string) {
  const { job, show } = await requireOwnedJob(backend, editor, jobId);
  const moved = await transitionJob(
    backend.db,
    job.id,
    "cancelled",
    { finishedAt: new Date() },
    "cancelled by editor",
  );
  // Already finished: the result stands and the caller gets the current state.
  return { job: moved ?? job, show };
}

export async function retryAnalysis(backend: Backend, editor: Editor, jobId: string) {
  const { job, show } = await requireOwnedJob(backend, editor, jobId);
  const retryable =
    job.state === "partial" ||
    job.state === "cancelled" ||
    (job.state === "failed" && job.failureRetryable);
  if (!retryable) {
    throw new ApiError(409, "not-retryable", "This analysis cannot be run again.");
  }
  await assertRollingBudget(backend, editor.id);
  const { job: queued, conflict } = await requeueJob(backend.db, job.id);
  if (conflict) {
    // Another analysis of the same show is live, so that one is the answer.
    const live = await findJobByIdentity(backend.db, editor.id, job.identityKey);
    if (live) return { job: live, show };
  }
  if (!queued) return { job, show };
  return { job: await launch(backend, queued), show };
}

export type StoredResults = { ranking: Uint8Array; promos: Uint8Array };

function assertHasResults(job: JobRow): asserts job is JobRow & {
  rankingKey: string;
  promosKey: string;
} {
  const ready = job.state === "completed" || job.state === "partial";
  if (!ready || !job.rankingKey || !job.promosKey) {
    throw new ApiError(409, "not-ready", "This analysis has no results yet.");
  }
}

/** Changes whenever a new attempt could have produced different results. */
export const resultsTag = (job: JobRow) => `"${job.id}-${job.attempt}-${job.revision}"`;

export function assertResultsReady(job: JobRow): void {
  assertHasResults(job);
}

/** Reads what the analysis stored. Nothing is ever recomputed here. */
export async function readResults(backend: Backend, job: JobRow): Promise<StoredResults> {
  assertHasResults(job);
  const [ranking, promos] = await Promise.all([
    backend.storage.get(job.rankingKey),
    backend.storage.get(job.promosKey),
  ]);
  if (!ranking || !promos) {
    logEvent("job.results-missing", { jobId: job.id, errorCategory: "missing-result" });
    throw new ApiError(410, "missing-result", "These results are no longer available.");
  }
  return { ranking, promos };
}

export async function readEpisode(
  backend: Backend,
  show: ShowRow,
  number: number,
): Promise<Episode> {
  const bytes = await backend.storage.get(episodeKey(show, number));
  if (!bytes) throw new ApiError(404, "not-found", "That was not found.");
  const episode = episodeSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  // Writer notes are spoilers the workspace never shows, so they stay on the server.
  return { ...episode, writerNotes: { otherFields: [] } };
}
