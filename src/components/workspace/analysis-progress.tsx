import type { AnalysisJob, JobStage } from "@/domain/analysis-job";
import { FAILURE_COPY, PROGRESS_STEPS, STAGE_COPY } from "@/client/job-copy";
import { formatFileSize, joinClasses } from "@/client/format";
import type { UploadProgress } from "@/client/service";
import { BrandMark } from "@/components/brand/brand-mark";

type StepState = "done" | "current" | "failed" | "waiting" | "stopped";

const STATE_WORD: Record<StepState, string> = {
  done: "Done",
  current: "In progress",
  failed: "Failed",
  stopped: "Stopped",
  waiting: "Not started",
};

function StepIcon({ state }: { state: StepState }) {
  if (state === "current") return <BrandMark size={20} animated />;
  if (state === "done") {
    return (
      <svg
        viewBox="0 0 20 20"
        width="20"
        height="20"
        aria-hidden="true"
        className="text-accent-ink"
      >
        <path
          d="M5 10.5 8.5 14 15 6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (state === "failed") {
    return (
      <span
        aria-hidden="true"
        className="flex size-5 items-center justify-center rounded-full bg-danger-surface text-xs font-bold text-danger"
      >
        !
      </span>
    );
  }
  return <span aria-hidden="true" className="block size-2.5 rounded-full bg-line-strong/50" />;
}

export function activeStage(job: AnalysisJob | null): JobStage {
  if (!job) return "uploading";
  if (job.failure) return job.failure.stage;
  // A queued job has its file, and checking it is the next thing that happens.
  if (job.state === "queued") return "validating";
  const stage = STAGE_COPY.find((s) => s.id === job.state);
  return stage?.id ?? "ranking";
}

export function statusLine(job: AnalysisJob | null): string {
  if (job?.state === "failed" && job.failure) return FAILURE_COPY[job.failure.code].title;
  if (job?.state === "cancelled") return "This analysis was stopped.";
  if (job?.state === "queued") return "Your file is saved. The analysis is about to start.";
  const stage = activeStage(job);
  return STAGE_COPY.find((s) => s.id === stage)?.description ?? "";
}

/** Counts the service has actually reported within the current stage. */
export function progressLine(job: AnalysisJob | null): string | null {
  const progress = job?.facts.progress;
  if (!progress) return null;
  const { done, total, unit } = progress;
  if (unit === "episodes") return `${done} of ${total ?? "?"} episodes searched`;
  if (unit === "screened") {
    return total
      ? `${done} of ${total} clips given a quick read`
      : `${done} clips given a quick read`;
  }
  if (unit === "moments") {
    return total ? `${done} of ${total} planned detailed evaluations` : `${done} moments evaluated`;
  }
  return total ? `${done} of ${total} comparisons` : `${done} comparisons made`;
}

function stepState(index: number, active: number, job: AnalysisJob | null): StepState {
  // During the upload, or when the upload itself failed, no step has started.
  if (active < 0) return "waiting";
  if (index < active) return "done";
  if (index > active) return "waiting";
  if (job?.state === "failed") return "failed";
  if (job?.state === "cancelled") return "stopped";
  return "current";
}

/** What has been counted so far, shown under the step it belongs to. */
function stepFact(index: number, state: StepState, job: AnalysisJob | null): string | null {
  const facts = job?.facts;
  if (index === 0 && facts?.episodes !== undefined) return `${facts.episodes} episodes read`;
  if (index === 1 && facts?.moments !== undefined) return `${facts.moments} moments found`;
  return state === "current" ? progressLine(job) : null;
}

/** A few plain steps, each tied to real server stages. It never shows an invented percent. */
export function AnalysisProgress({
  job,
  upload,
}: {
  job: AnalysisJob | null;
  upload: UploadProgress | null;
}) {
  const stage = activeStage(job);
  const active = PROGRESS_STEPS.findIndex((step) => step.stages.includes(stage));

  return (
    <div>
      {upload ? (
        <div className="mb-8">
          <progress
            className="h-1.5 w-full accent-accent-ink"
            max={upload.totalBytes}
            value={upload.loadedBytes}
            aria-label="Upload progress"
          />
          <p className="mt-1.5 text-sm text-ink-muted tabular-nums">
            {formatFileSize(upload.loadedBytes)} of {formatFileSize(upload.totalBytes)}
          </p>
        </div>
      ) : null}
      <ol className="space-y-4">
        {PROGRESS_STEPS.map(({ label }, index) => {
          const state = stepState(index, active, job);
          const fact = stepFact(index, state, job);
          return (
            <li
              key={label}
              aria-current={state === "current" ? "step" : undefined}
              className="flex gap-3"
            >
              <span className="flex h-6 w-5 shrink-0 items-center justify-center">
                <StepIcon state={state} />
              </span>
              <div>
                <p
                  className={joinClasses(
                    "leading-6",
                    state === "waiting" && "text-ink-muted",
                    state === "current" && "font-semibold",
                    state === "failed" && "font-semibold text-danger",
                  )}
                >
                  {label}
                  <span className="sr-only">, {STATE_WORD[state]}</span>
                </p>
                {fact ? <p className="text-sm text-ink-muted tabular-nums">{fact}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
