import { and, eq, lt, notInArray } from "drizzle-orm";

import { TERMINAL_STATES } from "../domain/analysis-job.ts";
import type { Backend } from "./backend.ts";
import { analysisJobs, rateLimits, shows, uploads } from "./db/schema.ts";
import { liveJobsForShow, type ShowRow } from "./jobs.ts";
import { logEvent } from "./log.ts";
import { jobPrefix, showPrefix } from "./storage.ts";

/**
 * Deleting confidential material. A show's ZIP, parsed episodes, cached model
 * answers, and results all go together. Storage is cleared first, so a failure
 * part way leaves the database row in place and the delete can be repeated.
 */

export type DeleteOutcome = "deleted" | "not-found" | "busy";

async function deleteShowRow(backend: Backend, show: ShowRow): Promise<void> {
  const { db, storage } = backend;
  const jobs = await db
    .select({ id: analysisJobs.id })
    .from(analysisJobs)
    .where(eq(analysisJobs.showId, show.id));
  const keys = [
    show.storageKey,
    ...(await storage.list(showPrefix(show.ownerId, show.id))),
    ...(await Promise.all(jobs.map((job) => storage.list(jobPrefix(show.ownerId, job.id))))).flat(),
  ];
  await storage.delete([...new Set(keys)]);
  // Jobs, audit rows, spend records, and cached answers go with it through foreign keys.
  await db.delete(shows).where(eq(shows.id, show.id));
  logEvent("show.deleted", {});
}

export async function deleteOwnedShow(
  backend: Backend,
  ownerId: string,
  showId: string,
): Promise<DeleteOutcome> {
  const [show] = await backend.db
    .select()
    .from(shows)
    .where(and(eq(shows.id, showId), eq(shows.ownerId, ownerId)))
    .limit(1);
  if (!show) return "not-found";
  if ((await liveJobsForShow(backend.db, show.id)) > 0) return "busy";
  await deleteShowRow(backend, show);
  return "deleted";
}

/**
 * Finds what has passed its retention date. Nothing is removed unless `apply`
 * is true, and shows with a job still running are always left alone.
 */
export async function sweepExpired(
  backend: Backend,
  options: { apply: boolean; now: Date },
): Promise<{ shows: number; uploads: number; skippedBusy: number }> {
  const { db, storage } = backend;
  const expired = await db.select().from(shows).where(lt(shows.expiresAt, options.now));
  const staleUploads = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.status, "open"), lt(uploads.expiresAt, options.now)));
  let removed = 0;
  let skippedBusy = 0;
  for (const show of expired) {
    const [live] = await db
      .select({ id: analysisJobs.id })
      .from(analysisJobs)
      .where(
        and(eq(analysisJobs.showId, show.id), notInArray(analysisJobs.state, [...TERMINAL_STATES])),
      )
      .limit(1);
    if (live) {
      skippedBusy += 1;
      continue;
    }
    removed += 1;
    if (options.apply) await deleteShowRow(backend, show);
  }
  if (options.apply) {
    await db
      .delete(rateLimits)
      .where(lt(rateLimits.windowStart, new Date(options.now.getTime() - 86_400_000)));
    for (const upload of staleUploads) {
      await storage.delete([upload.storageKey]);
      await db.update(uploads).set({ status: "rejected" }).where(eq(uploads.id, upload.id));
    }
  }
  return { shows: removed, uploads: staleUploads.length, skippedBusy };
}
