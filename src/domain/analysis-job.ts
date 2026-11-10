import { z } from "zod";

/**
 * The lifecycle of one analysis. The browser reads this contract, and the
 * server keeps it in PostgreSQL.
 *
 * Progress is stage based. `facts` holds only numbers the server actually
 * knows. A field that is absent is shown as nothing, never as an estimate.
 */

export const JOB_STAGES = [
  "uploading",
  "validating",
  "parsing",
  "discovering",
  "evaluating",
  "ranking",
] as const;
export const JOB_OUTCOMES = ["completed", "partial", "failed", "cancelled"] as const;
export const JOB_STATES = ["queued", ...JOB_STAGES, ...JOB_OUTCOMES] as const;
export const JOB_FAILURES = [
  "invalid-archive",
  "unsupported-format",
  "no-episodes",
  "too-large",
  "provider-unavailable",
  "model-output-invalid",
  "budget-reached",
  "storage-unavailable",
  "missing-result",
  "workflow-start",
  "interrupted",
  "internal",
] as const;

export const analysisJobSchema = z.object({
  id: z.string().min(1),
  fileName: z.string().min(1),
  state: z.enum(JOB_STATES),
  facts: z.object({
    /** How many promos the editor asked for. Absent on analyses from before rank-4 (10). */
    requested: z.number().int().positive().optional(),
    episodes: z.number().int().nonnegative().optional(),
    moments: z.number().int().nonnegative().optional(),
    /** Real progress within the current stage. `total` is absent when it is not known yet. */
    progress: z
      .object({
        done: z.number().int().nonnegative(),
        total: z.number().int().positive().optional(),
        unit: z.enum(["episodes", "screened", "moments", "comparisons"]),
      })
      .optional(),
    /** Estimated time left, recomputed from the work actually remaining. */
    remainingMs: z.object({ low: z.number(), high: z.number() }).optional(),
    /** True while the run is pausing because the model provider failed, before trying again. */
    waiting: z.boolean().optional(),
    /** Set when the analysis finishes. */
    returned: z.number().int().nonnegative().optional(),
    elapsedMs: z.number().int().nonnegative().optional(),
    costUsd: z.object({ billed: z.number().nullable(), estimated: z.number() }).optional(),
  }),
  /** Set only when state is "failed". */
  failure: z
    .object({
      code: z.enum(JOB_FAILURES),
      stage: z.enum(JOB_STAGES),
      retryable: z.boolean(),
    })
    .nullable(),
  canCancel: z.boolean(),
  /** How long the browser should wait before asking again. */
  pollAfterMs: z.number().int().positive(),
});

export type AnalysisJob = z.infer<typeof analysisJobSchema>;
export type JobState = AnalysisJob["state"];
export type JobStage = (typeof JOB_STAGES)[number];
export type JobFailureCode = (typeof JOB_FAILURES)[number];
export type JobFacts = AnalysisJob["facts"];

/** One line in the editor's list of past analyses. */
export const jobSummarySchema = z.object({
  job: analysisJobSchema,
  showId: z.string().min(1),
  createdAt: z.string().min(1),
  finishedAt: z.string().nullable(),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

/**
 * The only moves a job can make. A failed, partial, or cancelled job can go
 * back to queued for a retry, and nothing else. A completed job never moves.
 */
export const LEGAL_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["validating", "failed", "cancelled"],
  uploading: ["queued", "failed", "cancelled"],
  validating: ["parsing", "failed", "cancelled"],
  parsing: ["discovering", "failed", "cancelled"],
  discovering: ["evaluating", "partial", "failed", "cancelled"],
  evaluating: ["ranking", "completed", "partial", "failed", "cancelled"],
  ranking: ["completed", "partial", "failed", "cancelled"],
  completed: [],
  partial: ["queued"],
  failed: ["queued"],
  cancelled: ["queued"],
};

export const TERMINAL_STATES: readonly JobState[] = JOB_OUTCOMES;

export const isTerminal = (state: JobState) => TERMINAL_STATES.includes(state);

export const canTransition = (from: JobState, to: JobState) => LEGAL_TRANSITIONS[from].includes(to);
