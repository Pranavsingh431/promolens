import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../../src/server/db/client";
import { analysisJobs, editors, jobEvents, shows } from "../../src/server/db/schema";
import { claimJob, createOrReuseJob, transitionJob } from "../../src/server/jobs";
import { hitRateLimit } from "../../src/server/rate-limit";

/**
 * PGlite runs one query at a time, so real races need a real server. Set
 * TEST_DATABASE_URL to a throwaway database, with migrations applied, to run these.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("on a real PostgreSQL server, with real parallelism", () => {
  async function setup(): Promise<{ db: Database; ownerId: string; showId: string }> {
    const db = await openDatabase(url as string);
    const unique = crypto.randomUUID();
    const [owner] = await db.insert(editors).values({ name: unique }).returning();
    const [show] = await db
      .insert(shows)
      .values({
        ownerId: owner?.id as string,
        title: "Made-up",
        fileName: "a.zip",
        archiveSha256: "a".repeat(64),
        contentSha256: "a".repeat(64),
        sizeBytes: 1,
        storageKey: `uploads/${unique}`,
        episodeCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    return { db, ownerId: owner?.id as string, showId: show?.id as string };
  }

  it("creates exactly one job from many simultaneous requests", async () => {
    const { db, ownerId, showId } = await setup();
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        createOrReuseJob(db, { ownerId, showId, identityKey: "same", pipelineVersion: "t" }),
      ),
    );
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it("lets exactly one run claim a job", async () => {
    const { db, ownerId, showId } = await setup();
    const { job } = await createOrReuseJob(db, {
      ownerId,
      showId,
      identityKey: "claim",
      pipelineVersion: "t",
    });
    const claims = await Promise.all(
      Array.from({ length: 30 }, (_, i) => claimJob(db, job.id, `run-${i}`)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("applies exactly one of several competing moves", async () => {
    const { db, ownerId, showId } = await setup();
    const { job } = await createOrReuseJob(db, {
      ownerId,
      showId,
      identityKey: "race",
      pipelineVersion: "t",
    });
    await transitionJob(db, job.id, "validating");
    await transitionJob(db, job.id, "parsing");
    await transitionJob(db, job.id, "discovering");
    await transitionJob(db, job.id, "evaluating");
    await transitionJob(db, job.id, "ranking");
    const moves = await Promise.all(
      (["completed", "failed", "cancelled", "partial", "completed", "cancelled"] as const).map(
        (to) => transitionJob(db, job.id, to),
      ),
    );
    expect(moves.filter(Boolean)).toHaveLength(1);
    const events = await db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id));
    expect(events).toHaveLength(7);
    const [row] = await db.select().from(analysisJobs).where(eq(analysisJobs.id, job.id));
    expect(row?.state).toBe(events.at(-1)?.toState);
  });

  it("counts a rate limit correctly under parallel load", async () => {
    const { db } = await setup();
    const key = `rate-${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 30 }, () => hitRateLimit(db, key, 10, 60_000)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });
});
