import type { AnalysisJob, JobStage } from "@/domain/analysis-job";
import { FAILURE_COPY, STAGE_COPY } from "@/client/job-copy";
import { formatFileSize, joinClasses } from "@/client/format";
import type { UploadProgress } from "@/client/service";
import { BrandMark } from "@/components/brand/brand-mark";

type StageState = "done" | "current" | "failed" | "waiting" | "stopped";

function stageState(stage: JobStage, active: JobStage, job: AnalysisJob | null): StageState {
  const order = STAGE_COPY.map((s) => s.id);
  const position = order.indexOf(stage);
  const activePosition = order.indexOf(active);
  if (position < activePosition) return "done";
  if (position > activePosition) return "waiting";
  if (job?.state === "failed") return "failed";
  if (job?.state === "cancelled") return "stopped";
  return "current";
}

const STATE_WORD: Record<StageState, string> = {
  done: "Done",
  current: "In progress",
  failed: "Failed",
  stopped: "Stopped",
  waiting: "Not started",
};

function StageIcon({ state }: { state: StageState }) {
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
  return (
    <span
      aria-hidden="true"
      className="mx-1 block size-3 rounded-full border-2 border-line-strong"
    />
  );
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
  if (unit === "moments") return `${done} moments evaluated`;
  return `${done} comparisons made`;
}

/** Stage-based progress. It shows only what the service has reported, with no invented percent. */
export function AnalysisProgress({
  job,
  upload,
}: {
  job: AnalysisJob | null;
  upload: UploadProgress | null;
}) {
  const active = activeStage(job);
  const facts = [
    job?.facts.episodes !== undefined ? `${job.facts.episodes} episodes read` : null,
    job?.facts.moments !== undefined ? `${job.facts.moments} moments found` : null,
    progressLine(job),
  ].filter(Boolean);

  return (
    <div>
      <ol className="space-y-3">
        {STAGE_COPY.map(({ id, label }) => {
          const state = stageState(id, active, job);
          return (
            <li
              key={id}
              aria-current={state === "current" ? "step" : undefined}
              className="flex items-center gap-3"
            >
              <span className="flex w-5 justify-center">
                <StageIcon state={state} />
              </span>
              <span
                className={joinClasses(
                  "text-sm",
                  state === "waiting" && "text-ink-muted",
                  state === "current" && "font-semibold",
                  state === "failed" && "font-semibold text-danger",
                )}
              >
                {label}
              </span>
              <span className="sr-only">{STATE_WORD[state]}</span>
            </li>
          );
        })}
      </ol>
      {upload ? (
        <div className="mt-5">
          <progress
            className="h-1.5 w-full accent-accent-ink"
            max={upload.totalBytes}
            value={upload.loadedBytes}
            aria-label="Upload progress"
          />
          <p className="mt-1 font-mono text-xs text-ink-muted">
            {formatFileSize(upload.loadedBytes)} of {formatFileSize(upload.totalBytes)}
          </p>
        </div>
      ) : null}
      {facts.length ? (
        <p className="mt-5 font-mono text-xs text-ink-muted">{facts.join(" · ")}</p>
      ) : null}
    </div>
  );
}
