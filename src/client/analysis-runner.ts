import type { AnalysisJob, JobState } from "@/domain/analysis-job";

import {
  ServiceError,
  toServiceError,
  type AnalysisResults,
  type AnalysisService,
  type UploadProgress,
} from "./service";

/**
 * Runs one analysis from start to finish, driven only by what the service
 * reports. Nothing here advances on a timer of its own, so what the editor
 * sees is always what the service last said.
 */

export type AnalysisSession =
  | { phase: "idle" }
  | { phase: "opening" }
  | { phase: "submitting"; fileName: string; upload: UploadProgress | null }
  | { phase: "running"; job: AnalysisJob; cancelling: boolean }
  | { phase: "loading-results"; job: AnalysisJob }
  | { phase: "results"; job: AnalysisJob; results: AnalysisResults }
  | { phase: "stopped"; job: AnalysisJob }
  | { phase: "unavailable"; fileName: string }
  | { phase: "error"; error: ServiceError; fileName: string; canRetry: boolean };

/** Polls that may fail in a row before the editor is asked what to do. */
const MAX_POLL_FAILURES = 3;

const OUTCOMES: ReadonlySet<JobState> = new Set(["completed", "partial", "failed", "cancelled"]);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

export type RunnerOptions = {
  /** Resolves when the tab is in view, so a hidden tab sends no requests. */
  whenVisible?: (signal: AbortSignal) => Promise<void>;
};

export function createAnalysisRunner(
  service: AnalysisService,
  emit: (session: AnalysisSession) => void,
  options: RunnerOptions = {},
) {
  let session: AnalysisSession = { phase: "idle" };
  let controller: AbortController | null = null;
  let file: File | null = null;
  // What "Try again" should do. Updated each time work is about to start.
  let recover: () => void = () => {};

  function set(next: AnalysisSession) {
    session = next;
    emit(next);
  }

  function begin(): AbortSignal {
    controller?.abort();
    controller = new AbortController();
    return controller.signal;
  }

  function fail(error: unknown, fileName: string) {
    if (isAbort(error)) return;
    const failure = toServiceError(error);
    if (failure.kind === "unavailable") set({ phase: "unavailable", fileName });
    else set({ phase: "error", error: failure, fileName, canRetry: failure.retryable });
  }

  async function loadResults(job: AnalysisJob, signal: AbortSignal) {
    recover = () => void loadResults(job, begin());
    set({ phase: "loading-results", job });
    try {
      const raw = await service.getResults(job.id, { signal });
      const { parseResults } = await import("./parse-results");
      const results = parseResults(raw);
      if (!signal.aborted) set({ phase: "results", job, results });
    } catch (error) {
      fail(error, job.fileName);
    }
  }

  async function follow(start: AnalysisJob, signal: AbortSignal) {
    let job = start;
    let failures = 0;
    recover = () => void follow(job, begin());
    try {
      while (!OUTCOMES.has(job.state)) {
        set({ phase: "running", job, cancelling: false });
        await sleep(job.pollAfterMs, signal);
        await options.whenVisible?.(signal);
        try {
          job = await service.getJob(job.id, { signal });
          failures = 0;
        } catch (error) {
          failures += 1;
          const failure = toServiceError(error);
          if (isAbort(error) || !failure.retryable || failures >= MAX_POLL_FAILURES) throw error;
        }
      }
    } catch (error) {
      fail(error, start.fileName);
      return;
    }
    if (job.state === "completed" || job.state === "partial") await loadResults(job, signal);
    else set({ phase: "stopped", job });
  }

  async function start(chosen: File) {
    file = chosen;
    const signal = begin();
    recover = () => void start(chosen);
    set({ phase: "submitting", fileName: chosen.name, upload: null });
    try {
      const job = await service.startAnalysis(chosen, {
        signal,
        onUploadProgress: (upload) => {
          if (session.phase === "submitting") set({ ...session, upload });
        },
      });
      await follow(job, signal);
    } catch (error) {
      fail(error, chosen.name);
    }
  }

  /** Picks up an analysis that already exists, as after a refresh. */
  async function open(jobId: string) {
    const signal = begin();
    recover = () => void open(jobId);
    set({ phase: "opening" });
    try {
      await follow(await service.getJob(jobId, { signal }), signal);
    } catch (error) {
      fail(error, "this analysis");
    }
  }

  async function retryStopped(job: AnalysisJob) {
    const signal = begin();
    recover = () => void retryStopped(job);
    set({ phase: "opening" });
    try {
      await follow(
        await (service.retryJob as (id: string) => Promise<AnalysisJob>)(job.id),
        signal,
      );
    } catch (error) {
      fail(error, job.fileName);
    }
  }

  async function cancel() {
    if (session.phase !== "running") return;
    const { job } = session;
    set({ phase: "running", job, cancelling: true });
    begin();
    try {
      set({ phase: "stopped", job: await service.cancelJob(job.id) });
    } catch (error) {
      fail(error, job.fileName);
    }
  }

  return {
    start: (chosen: File) => void start(chosen),
    open: (jobId: string) => void open(jobId),
    cancel: () => void cancel(),
    retry: () => recover(),
    restart: () => {
      const canRerun =
        session.phase === "stopped" ||
        (session.phase === "results" && session.job.state === "partial");
      if (canRerun && service.retryJob && "job" in session) void retryStopped(session.job);
      else if (file) void start(file);
    },
    reset: () => {
      begin();
      set({ phase: "idle" });
    },
    dispose: () => controller?.abort(),
  };
}
