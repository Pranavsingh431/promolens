CREATE TYPE "public"."job_failure" AS ENUM('invalid-archive', 'unsupported-format', 'no-episodes', 'too-large', 'provider-unavailable', 'model-output-invalid', 'budget-reached', 'storage-unavailable', 'missing-result', 'workflow-start', 'interrupted', 'internal');--> statement-breakpoint
CREATE TYPE "public"."job_stage" AS ENUM('uploading', 'validating', 'parsing', 'discovering', 'evaluating', 'ranking');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('queued', 'uploading', 'validating', 'parsing', 'discovering', 'evaluating', 'ranking', 'completed', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('open', 'completed', 'rejected');--> statement-breakpoint
CREATE TABLE "analysis_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"show_id" uuid NOT NULL,
	"identity_key" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"failure_code" "job_failure",
	"failure_stage" "job_stage",
	"failure_retryable" boolean,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"workflow_run_id" text,
	"ranking_key" text,
	"promos_key" text,
	"manifest_key" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "editors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "editors_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "inference_cache" (
	"owner_id" uuid NOT NULL,
	"cache_key" text NOT NULL,
	"kind" text NOT NULL,
	"show_id" uuid NOT NULL,
	"entry" jsonb,
	"refused_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_cache_owner_id_cache_key_pk" PRIMARY KEY("owner_id","cache_key")
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"from_state" "job_state",
	"to_state" "job_state" NOT NULL,
	"detail" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_spend" (
	"job_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"phase" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"spent_usd" double precision DEFAULT 0 NOT NULL,
	"billed_usd" double precision,
	"estimated_usd" double precision DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"live_judgments" integer DEFAULT 0 NOT NULL,
	"cached_judgments" integer DEFAULT 0 NOT NULL,
	"failed_judgments" integer DEFAULT 0 NOT NULL,
	"refused_judgments" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_spend_job_id_step_key_pk" PRIMARY KEY("job_id","step_key")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"editor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"file_name" text NOT NULL,
	"archive_sha256" text NOT NULL,
	"content_sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"episode_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"declared_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"status" "upload_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uploads_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_owner_id_editors_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."editors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_cache" ADD CONSTRAINT "inference_cache_owner_id_editors_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."editors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_cache" ADD CONSTRAINT "inference_cache_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_analysis_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."analysis_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_spend" ADD CONSTRAINT "job_spend_job_id_analysis_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."analysis_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_editor_id_editors_id_fk" FOREIGN KEY ("editor_id") REFERENCES "public"."editors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shows" ADD CONSTRAINT "shows_owner_id_editors_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."editors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_owner_id_editors_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."editors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_jobs_identity_unique" ON "analysis_jobs" USING btree ("owner_id","identity_key") WHERE "analysis_jobs"."state" not in ('failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "analysis_jobs_owner_created_idx" ON "analysis_jobs" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "analysis_jobs_show_idx" ON "analysis_jobs" USING btree ("show_id");--> statement-breakpoint
CREATE INDEX "inference_cache_show_idx" ON "inference_cache" USING btree ("show_id");--> statement-breakpoint
CREATE INDEX "job_events_job_idx" ON "job_events" USING btree ("job_id","id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shows_owner_content_unique" ON "shows" USING btree ("owner_id","content_sha256");--> statement-breakpoint
CREATE INDEX "shows_expires_idx" ON "shows" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "uploads_expires_idx" ON "uploads" USING btree ("expires_at");