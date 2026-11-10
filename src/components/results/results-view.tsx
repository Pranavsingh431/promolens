"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { AnalysisJob } from "@/domain/analysis-job";
import { formatRange, formatSeconds } from "@/client/format";
import { buildResultsModel, type PromoRow, type UnevaluatedRow } from "@/client/results-model";
import type { AnalysisResults, AnalysisService } from "@/client/service";
import { createEpisodeCache } from "@/client/use-episodes";
import { useMediaQuery } from "@/client/use-media-query";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusPill } from "@/components/ui/status-pill";

import { AboutAnalysis } from "./about-analysis";
import { DetailShell } from "./detail-shell";
import { ExportControls } from "./export-controls";
import { PromoCard } from "./promo-card";
import { PromoDetail, UnevaluatedDetail } from "./promo-detail";

type ResultsViewProps = {
  service: AnalysisService;
  job: AnalysisJob;
  results: AnalysisResults;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onStartOver: () => void;
  /** Offered only by a service that can rerun an analysis. */
  onRetry?: (() => void) | undefined;
};

const WIDE = "(min-width: 64rem)";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function ResultsView({
  service,
  job,
  results,
  headingRef,
  onStartOver,
  onRetry,
}: ResultsViewProps) {
  const model = useMemo(() => buildResultsModel(results), [results]);
  const cache = useMemo(() => createEpisodeCache(service, job.id), [service, job.id]);
  const isWide = useMediaQuery(WIDE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [alternativesOpen, setAlternativesOpen] = useState(false);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const cards = useRef(new Map<string, HTMLButtonElement>());

  const firstId = model.recommended[0]?.id ?? null;
  // On a wide screen the top pick is ready to read. Nothing opens over the list on a phone.
  const activeId = selectedId ?? (isWide ? firstId : null);

  const allRows = useMemo(
    () => [...model.recommended, ...model.alternatives],
    [model.recommended, model.alternatives],
  );
  const selectedRow = allRows.find((row) => row.id === activeId) ?? null;
  const selectedGap = model.unevaluated.find((row) => row.id === activeId) ?? null;

  const open = useCallback((id: string) => {
    setSelectedId(id);
    requestAnimationFrame(() => panelHeading.current?.focus({ preventScroll: true }));
  }, []);

  const closePanel = useCallback(() => {
    const id = activeId;
    setSelectedId(null);
    if (id) cards.current.get(id)?.focus({ preventScroll: true });
  }, [activeId]);

  const cardRef = useCallback(
    (id: string) => (element: HTMLButtonElement | null) => {
      if (element) cards.current.set(id, element);
      else cards.current.delete(id);
    },
    [],
  );

  // This screen loads after the workspace changes phase, so it moves focus to its own heading.
  useEffect(() => headingRef.current?.focus(), [headingRef]);

  // On a phone the Back button should close the full-screen detail, not leave the page.
  const showingModal = !isWide && (selectedRow !== null || selectedGap !== null);
  useEffect(() => {
    if (!showingModal) return;
    window.history.pushState(window.history.state, "", window.location.href);
    const onPop = () => setSelectedId(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [showingModal]);

  const closeModal = useCallback(() => {
    // Removes the history entry added on open; the popstate above clears the selection.
    window.history.back();
  }, []);

  const total = model.recommended.length + model.alternatives.length;
  const missingNote = model.unevaluated.length
    ? `${plural(model.unevaluated.length, "moment")} could not be evaluated and ${
        model.unevaluated.length === 1 ? "is" : "are"
      } only listed in the full report.`
    : null;

  const detail = selectedRow ? (
    <PromoDetail
      key={selectedRow.id}
      row={selectedRow}
      rows={allRows}
      cache={cache}
      headingRef={panelHeading}
      onClose={isWide ? closePanel : closeModal}
      closeLabel={isWide ? "Close" : "Back to list"}
    />
  ) : selectedGap ? (
    <UnevaluatedDetail
      key={selectedGap.id}
      row={selectedGap}
      cache={cache}
      headingRef={panelHeading}
      onClose={isWide ? closePanel : closeModal}
      closeLabel={isWide ? "Close" : "Back to list"}
    />
  ) : null;

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="font-display text-4xl focus:outline-none sm:text-5xl"
          >
            Ranked promos
          </h1>
          <p className="mt-1 text-sm text-ink-muted [overflow-wrap:anywhere]">{job.fileName}</p>
        </div>
        {total > 0 ? (
          <ExportControls service={service} jobId={job.id} missingNote={missingNote} />
        ) : null}
      </header>

      <p className="mt-3 max-w-3xl text-sm text-ink-muted">
        These picks were evaluated by AI and checked against the script. No person has rated them,
        and the editorial score does not predict views.
      </p>

      {model.partial ? (
        <div className="mt-4 rounded-md border border-accent-ink px-4 py-3 text-sm">
          <p className="font-semibold">This analysis did not finish</p>
          <p className="mt-0.5 text-ink-muted">
            Everything below was fully evaluated, but some moments were not, so strong clips may be
            missing.
          </p>
          {onRetry ? (
            <span className="mt-2 block">
              <Button variant="secondary" onClick={onRetry}>
                Try the rest again
              </Button>
            </span>
          ) : null}
        </div>
      ) : null}

      {total === 0 && model.unevaluated.length === 0 ? (
        <div className="mt-8 max-w-2xl">
          <EmptyState title="No promos passed the checks" headingLevel="h2">
            PromoLens read this show, but no moment had a strong enough opening, ending, and clarity
            for a new viewer.
            <span className="mt-4 block">
              <Button onClick={onStartOver}>Analyze another file</Button>
            </span>
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(22rem,30rem)_minmax(0,1fr)]">
          <div>
            <RecommendedList
              rows={model.recommended}
              activeId={activeId}
              onOpen={open}
              cardRef={cardRef}
            />

            {model.alternatives.length ? (
              <details
                className="mt-6"
                onToggle={(event) => setAlternativesOpen(event.currentTarget.open)}
              >
                <summary className="cursor-pointer text-sm font-semibold">
                  Alternatives ({model.alternatives.length})
                </summary>
                <p className="mt-2 text-sm text-ink-muted">
                  These passed every check but did not make the list, often because they repeat a
                  recommended moment.
                </p>
                {alternativesOpen ? (
                  <ol className="mt-3 space-y-3">
                    {model.alternatives.map((row) => (
                      <li key={row.id}>
                        <PromoCard
                          row={row}
                          selected={row.id === activeId}
                          onOpen={open}
                          buttonRef={cardRef(row.id)}
                        />
                      </li>
                    ))}
                  </ol>
                ) : null}
              </details>
            ) : null}

            {model.unevaluated.length ? (
              <UnevaluatedList
                rows={model.unevaluated}
                activeId={activeId}
                onOpen={open}
                cardRef={cardRef}
              />
            ) : null}

            {model.notAssessed > 0 ? (
              <p className="mt-6 text-xs text-ink-muted">
                {plural(model.notAssessed, "other moment")} did not look strong enough on a first
                read to evaluate in detail.
              </p>
            ) : null}

            <AboutAnalysis results={results} service={service} jobId={job.id} />

            <div className="mt-6">
              <Button variant="quiet" onClick={onStartOver}>
                Analyze another file
              </Button>
            </div>
          </div>

          {isWide ? (
            <aside
              aria-label="Promo details"
              className="sticky top-4 max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-line bg-surface shadow-raised"
            >
              {detail ?? (
                <p className="p-10 text-center text-sm text-ink-muted">
                  Choose a promo to see why it was picked and where it sits in the script.
                </p>
              )}
            </aside>
          ) : null}
        </div>
      )}

      {!isWide && detail ? <DetailShell onDismiss={closeModal}>{detail}</DetailShell> : null}
    </>
  );
}

function RecommendedList({
  rows,
  activeId,
  onOpen,
  cardRef,
}: {
  rows: PromoRow[];
  activeId: string | null;
  onOpen: (id: string) => void;
  cardRef: (id: string) => (element: HTMLButtonElement | null) => void;
}) {
  return (
    <section aria-labelledby="recommended-heading">
      <h2 id="recommended-heading" className="text-sm font-semibold">
        Recommended ({rows.length})
      </h2>
      {rows.length ? (
        <ol className="mt-3 space-y-3">
          {rows.map((row) => (
            <li key={row.id}>
              <PromoCard
                row={row}
                selected={row.id === activeId}
                onOpen={onOpen}
                buttonRef={cardRef(row.id)}
              />
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-sm text-ink-muted">Nothing could be recommended from this run.</p>
      )}
    </section>
  );
}

function UnevaluatedList({
  rows,
  activeId,
  onOpen,
  cardRef,
}: {
  rows: UnevaluatedRow[];
  activeId: string | null;
  onOpen: (id: string) => void;
  cardRef: (id: string) => (element: HTMLButtonElement | null) => void;
}) {
  return (
    <section aria-labelledby="unevaluated-heading" className="mt-6">
      <h2 id="unevaluated-heading" className="text-sm font-semibold">
        Could not be evaluated ({rows.length})
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        These have no score. They were not rejected, so they are worth a look yourself.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((row) => {
          const first = row.segments[0];
          return (
            <li key={row.id}>
              <article className="relative rounded-md border border-line bg-surface p-3 hover:border-line-strong">
                <h3 className="font-mono text-sm font-medium">
                  <button
                    ref={cardRef(row.id)}
                    type="button"
                    onClick={() => onOpen(row.id)}
                    aria-current={row.id === activeId ? "true" : undefined}
                    className="cursor-pointer text-left after:absolute after:inset-0 after:rounded-md"
                  >
                    <span className="sr-only">Inspect unevaluated moment: </span>
                    {first
                      ? `Episode ${first.episode} · ${formatRange(first.startMs, first.endMs)}`
                      : row.id}
                  </button>
                </h3>
                <p className="font-mono text-xs text-ink-muted">{formatSeconds(row.durationMs)}</p>
                <div className="mt-2">
                  <StatusPill tone="danger">
                    {row.reason === "provider-refused"
                      ? "AI provider declined to review"
                      : "Evaluation failed"}
                  </StatusPill>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
