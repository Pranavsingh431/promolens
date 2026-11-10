"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { FAILURE_COPY, describeServiceError } from "@/client/job-copy";
import type { AnalysisService } from "@/client/service";
import { useAnalysis } from "@/client/use-analysis";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Notice } from "@/components/ui/notice";

import { AnalysisProgress, statusLine } from "./analysis-progress";
import { describeDuration, type WorkProfile } from "@/domain/estimate";

import type { Summarize } from "./promo-count";
import { UploadForm } from "./upload-form";

// Loaded only once there are results, so the upload screen stays light.
const ResultsView = dynamic(() => import("@/components/results/results-view"), {
  loading: () => <LoadingState label="Getting your results ready" />,
});

type WorkspaceProps = {
  service: AnalysisService;
  /** A short line under the upload form about what this build can do. */
  note?: ReactNode;
  /** Shown when the service reports that analysis is not connected. */
  unavailableAction?: ReactNode;
  sampleFile?: () => File;
  /** Opens this analysis on arrival, as after a refresh. */
  initialJobId?: string;
  /** Told which analysis is on screen, so the address can name it. */
  onJobChange?: (jobId: string | null) => void;
  /** Extra content under the upload form, with a way to open a past analysis. */
  renderIdle?: (openJob: (jobId: string) => void) => ReactNode;
  whenVisible?: (signal: AbortSignal) => Promise<void>;
  /** Offered when a session has ended, so the editor can get back in. */
  onSignInAgain?: () => void;
  /** A reassuring line under the progress steps, such as that the run survives closing the page. */
  progressNote?: ReactNode;
  /** Time and cost estimates before and during a run. Null when this setup cannot estimate. */
  estimateProfile?: WorkProfile | null;
  summarize?: Summarize;
};

const NARROW = "mx-auto max-w-2xl px-4 pt-12 pb-16 sm:px-6 sm:pt-20";

export function Workspace({
  service,
  note,
  unavailableAction,
  sampleFile,
  initialJobId,
  onJobChange,
  renderIdle,
  whenVisible,
  onSignInAgain,
  progressNote,
  estimateProfile = null,
  summarize,
}: WorkspaceProps) {
  const { session, start, open, cancel, retry, restart, reset, more } = useAnalysis(service, {
    initialJobId,
    ...(whenVisible ? { whenVisible } : {}),
  });
  // Held here so a chosen file survives moving between screens.
  const [file, setFile] = useState<File | null>(null);
  const startOver = () => {
    setFile(null);
    reset();
  };
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  // Each new screen moves focus to its heading, so keyboard and screen reader users follow along.
  const phase = session.phase;
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus();
  }, [phase]);

  const jobId = "job" in session ? session.job.id : null;
  const opening = phase === "opening";
  useEffect(() => {
    if (!opening) onJobChange?.(jobId);
  }, [jobId, opening, onJobChange]);

  if (session.phase === "results") {
    return (
      <main id="main" className="mx-auto max-w-3xl px-4 pt-10 pb-16 sm:px-6 sm:pt-14">
        <ResultsView
          service={service}
          job={session.job}
          results={session.results}
          headingRef={heading}
          onStartOver={startOver}
          onRetry={service.retryJob && session.job.state === "partial" ? restart : undefined}
          onRequestMore={service.requestMore ? more : undefined}
        />
      </main>
    );
  }

  if (session.phase === "submitting" || session.phase === "running") {
    const job = session.phase === "running" ? session.job : null;
    return (
      <main id="main" className={NARROW}>
        <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">
          {session.phase === "running" ? session.job.fileName : session.fileName}
        </p>
        <h1
          ref={heading}
          tabIndex={-1}
          className="mt-1 font-display text-4xl focus:outline-none sm:text-5xl"
        >
          Finding promos
        </h1>
        <p role="status" className="mt-3 text-lg text-ink-muted">
          {statusLine(job)}
        </p>
        {job?.facts.waiting ? (
          <p className="mt-2 text-sm font-medium text-accent-ink">
            Waiting for the AI service to respond. The analysis will try again shortly.
          </p>
        ) : job?.facts.remainingMs ? (
          <p className="mt-2 text-sm text-ink-muted">
            Time left: {describeDuration(job.facts.remainingMs)} (an estimate that updates as work
            finishes).
          </p>
        ) : null}
        <div className="mt-10">
          <AnalysisProgress
            job={job}
            upload={session.phase === "submitting" ? session.upload : null}
          />
        </div>
        {progressNote ? <p className="mt-10 text-sm text-ink-muted">{progressNote}</p> : null}
        {session.phase === "running" && session.job.canCancel ? (
          <div className="mt-6">
            <Button variant="quiet" onClick={() => void cancel()} disabled={session.cancelling}>
              {session.cancelling ? "Stopping" : "Cancel analysis"}
            </Button>
          </div>
        ) : null}
      </main>
    );
  }

  if (session.phase === "loading-results" || session.phase === "opening") {
    const opened = session.phase === "opening";
    return (
      <main id="main" className={NARROW}>
        <h1 ref={heading} tabIndex={-1} className="sr-only">
          {opened ? "Opening this analysis" : "Loading results"}
        </h1>
        <LoadingState label={opened ? "Opening this analysis" : "Getting your results ready"} />
      </main>
    );
  }

  if (session.phase === "stopped") {
    const { job } = session;
    const copy = job.failure ? FAILURE_COPY[job.failure.code] : null;
    return (
      <main id="main" className={NARROW}>
        <h1
          ref={heading}
          tabIndex={-1}
          className="font-display text-4xl [overflow-wrap:anywhere] focus:outline-none"
        >
          {job.fileName}
        </h1>
        <div className="mt-8">
          {copy ? (
            <ErrorState
              title={copy.title}
              message={copy.message}
              action={
                <div className="flex flex-wrap items-center gap-4">
                  {job.failure?.retryable ? <Button onClick={restart}>Try again</Button> : null}
                  <Button
                    variant={job.failure?.retryable ? "quiet" : "primary"}
                    onClick={startOver}
                  >
                    Choose another file
                  </Button>
                </div>
              }
            />
          ) : (
            <Notice title="Analysis stopped" action={<Button onClick={reset}>Start again</Button>}>
              You cancelled this analysis, so there are no results to show.
            </Notice>
          )}
        </div>
        <div className="mt-10">
          <AnalysisProgress job={job} upload={null} />
        </div>
      </main>
    );
  }

  if (session.phase === "error") {
    const copy = describeServiceError(session.error);
    return (
      <main id="main" className={NARROW}>
        <h1 ref={heading} tabIndex={-1} className="sr-only">
          Something went wrong
        </h1>
        <ErrorState
          title={copy.title}
          message={copy.message}
          action={
            <div className="flex flex-wrap items-center gap-4">
              {session.error.kind === "unauthorized" && onSignInAgain ? (
                <Button onClick={onSignInAgain}>Sign in</Button>
              ) : (
                <>
                  {session.canRetry ? <Button onClick={retry}>Try again</Button> : null}
                  <Button variant={session.canRetry ? "quiet" : "primary"} onClick={startOver}>
                    Start over
                  </Button>
                </>
              )}
            </div>
          }
        />
      </main>
    );
  }

  return (
    <main id="main" className={NARROW}>
      <h1
        ref={heading}
        tabIndex={-1}
        className="font-display text-5xl leading-[1.05] focus:outline-none sm:text-6xl"
      >
        Find promos in your screenplays
      </h1>
      <p className="mt-4 text-lg text-ink-muted">
        Upload a ZIP of a show&apos;s timestamped episode screenplays. PromoLens suggests 20 to
        60-second promos with exact timecodes, and you decide which to use.
      </p>
      {session.phase === "unavailable" ? (
        <div className="mt-8">
          <Notice title="Analysis is not connected yet" action={unavailableAction}>
            This preview cannot process screenplays, so {session.fileName} stayed on this computer.
          </Notice>
        </div>
      ) : null}
      <UploadForm
        file={file}
        onFileChange={setFile}
        onAnalyze={start}
        estimateProfile={estimateProfile}
        {...(summarize ? { summarize } : {})}
        {...(sampleFile ? { sampleFile } : {})}
      />
      {renderIdle?.(open)}
      {note && session.phase !== "unavailable" ? (
        <div className="mt-12 text-sm text-ink-muted">{note}</div>
      ) : null}
    </main>
  );
}
