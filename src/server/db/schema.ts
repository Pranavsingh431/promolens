import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { JOB_FAILURES, JOB_STAGES, JOB_STATES, type JobFacts } from "../../domain/analysis-job.ts";

/**
 * Durable state for the web workflow. Large or confidential artifacts live in
 * private object storage and are referenced here by key. Model answers are kept
 * in inference_cache so a stage can read hundreds of them in one query.
 */

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const jobState = pgEnum("job_state", JOB_STATES);
export const jobStage = pgEnum("job_stage", JOB_STAGES);
export const jobFailure = pgEnum("job_failure", JOB_FAILURES);
export const uploadStatus = pgEnum("upload_status", ["open", "completed", "rejected"]);

export const editors = pgTable("editors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  createdAt: created(),
});

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    editorId: uuid("editor_id")
      .notNull()
      .references(() => editors.id, { onDelete: "cascade" }),
    createdAt: created(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_expires_idx").on(t.expiresAt)],
);

/** A file on its way in. It becomes a show only after the server has read and validated it. */
export const uploads = pgTable(
  "uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => editors.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    declaredBytes: integer("declared_bytes").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    status: uploadStatus("status").notNull().default("open"),
    createdAt: created(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("uploads_expires_idx").on(t.expiresAt)],
);

export const shows = pgTable(
  "shows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => editors.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    fileName: text("file_name").notNull(),
    archiveSha256: text("archive_sha256").notNull(),
    /** Hash of the parsed screenplays, so a re-zipped copy of the same show is the same show. */
    contentSha256: text("content_sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    episodeCount: integer("episode_count").notNull(),
    createdAt: created(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("shows_owner_content_unique").on(t.ownerId, t.contentSha256),
    index("shows_expires_idx").on(t.expiresAt),
  ],
);

export const analysisJobs = pgTable(
  "analysis_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => editors.id, { onDelete: "cascade" }),
    showId: uuid("show_id")
      .notNull()
      .references(() => shows.id, { onDelete: "cascade" }),
    /** Owner, input content, and every setting that can change the answer. */
    identityKey: text("identity_key").notNull(),
    pipelineVersion: text("pipeline_version").notNull(),
    state: jobState("state").notNull().default("queued"),
    failureCode: jobFailure("failure_code"),
    failureStage: jobStage("failure_stage"),
    failureRetryable: boolean("failure_retryable"),
    facts: jsonb("facts").$type<JobFacts>().notNull().default({}),
    attempt: integer("attempt").notNull().default(1),
    /** The one workflow run allowed to work on this attempt. */
    workflowRunId: text("workflow_run_id"),
    rankingKey: text("ranking_key"),
    promosKey: text("promos_key"),
    manifestKey: text("manifest_key"),
    /** Raised on every change. The status endpoint uses it as its ETag. */
    revision: integer("revision").notNull().default(1),
    createdAt: created(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    // At most one live or finished job per logical analysis, enforced by the database.
    uniqueIndex("analysis_jobs_identity_unique")
      .on(t.ownerId, t.identityKey)
      .where(sql`${t.state} not in ('failed', 'cancelled')`),
    index("analysis_jobs_owner_created_idx").on(t.ownerId, t.createdAt),
    index("analysis_jobs_show_idx").on(t.showId),
  ],
);

/** The audit trail: state changes and error categories only, never screenplay text. */
export const jobEvents = pgTable(
  "job_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => analysisJobs.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    fromState: jobState("from_state"),
    toState: jobState("to_state").notNull(),
    detail: text("detail"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_events_job_idx").on(t.jobId, t.id)],
);

/**
 * What each durable step spent. While a step runs, `spentUsd` includes its
 * open reservations, so a step that crashes leaves an upper bound and a job
 * can never overspend by restarting.
 */
export const jobSpend = pgTable(
  "job_spend",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => analysisJobs.id, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    phase: text("phase").notNull(),
    status: text("status").notNull().default("running"),
    spentUsd: doublePrecision("spent_usd").notNull().default(0),
    billedUsd: doublePrecision("billed_usd"),
    estimatedUsd: doublePrecision("estimated_usd").notNull().default(0),
    requests: integer("requests").notNull().default(0),
    liveJudgments: integer("live_judgments").notNull().default(0),
    cachedJudgments: integer("cached_judgments").notNull().default(0),
    failedJudgments: integer("failed_judgments").notNull().default(0),
    refusedJudgments: integer("refused_judgments").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.stepKey] })],
);

/**
 * Validated model answers, addressed by the same content hash the file cache
 * uses. A row with a refusal kind and no entry records a declined request.
 */
export const inferenceCache = pgTable(
  "inference_cache",
  {
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => editors.id, { onDelete: "cascade" }),
    cacheKey: text("cache_key").notNull(),
    kind: text("kind").notNull(),
    showId: uuid("show_id")
      .notNull()
      .references(() => shows.id, { onDelete: "cascade" }),
    entry: jsonb("entry"),
    refusedKind: text("refused_kind"),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.cacheKey] }),
    index("inference_cache_show_idx").on(t.showId),
  ],
);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});

export const schema = {
  editors,
  sessions,
  uploads,
  shows,
  analysisJobs,
  jobEvents,
  jobSpend,
  inferenceCache,
  rateLimits,
};
