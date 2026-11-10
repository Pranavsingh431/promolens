"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { AnalysisJob } from "@/domain/analysis-job";
import { formatRange, formatSeconds } from "@/client/format";
import { buildResultsModel, type PromoRow, type UnevaluatedRow } from "@/client/results-model";
import type { AnalysisResults, AnalysisService } from "@/client/service";
import { createEpisodeCache } from "@/client/use-episodes";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

import { AboutAnalysis } from "./about-analysis";
import { DetailShell } from "./detail-shell";
import { ExportControls } from "./export-controls";
import { PromoCard } from "./promo-card";
import { PromoDetail, UnevaluatedDetail, type DetailNav } from "./promo-detail";

type ResultsViewProps = {
  service: AnalysisService;
  job: AnalysisJob;
  results: AnalysisResults;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onStartOver: () => void;
  /** Offered only by a service that can rerun an analysis. */
  onRetry?: (() => void) | undefined;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The ranked list comes first and stays calm. One promo opens at a time, in a
 * panel over the list, with everything about it in one place.
 */
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [alternativesOpen, setAlternativesOpen] = useState(false);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const cards = useRef(new Map<string, HTMLButtonElement>());
  const lastShown = useRef<string | null>(null);

  const allRows = useMemo(
    () => [...model.recommended, ...model.alternatives],
    [model.recommended, model.alternatives],
  );
  const selectedRow = allRows.find((row) => row.id === selectedId) ?? null;
  const selectedGap = model.unevaluated.find((row) => row.id === selectedId) ?? null;
  const showing = selectedRow !== null || selectedGap !== null;

  const cardRef = useCallback(
    (id: string) => (element: HTMLButtonElement | null) => {
      if (element) cards.current.set(id, element);
      else cards.current.delete(id);
    },
    [],
  );

  // This screen loads after the workspace changes phase, so it moves focus to its own heading.
  useEffect(() => headingRef.current?.focus(), [headingRef]);

  // Each promo shown moves focus to its heading. Closing returns focus to that promo's card.
  useEffect(() => {
    if (selectedId) {
      lastShown.current = selectedId;
      requestAnimationFrame(() => {
        // Next and Previous reuse the open panel, so each promo starts from its top.
        const panel = panelHeading.current?.closest("dialog");
        if (panel) panel.scrollTop = 0;
        panelHeading.current?.focus({ preventScroll: true });
      });
    } else if (lastShown.current) {
      cards.current.get(lastShown.current)?.focus();
      lastShown.current = null;
    }
  }, [selectedId]);

  // The Back button closes the detail instead of leaving the page.
  useEffect(() => {
    if (!showing) return;
    window.history.pushState(window.history.state, "", window.location.href);
    const onPop = () => setSelectedId(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [showing]);

  // Removes the history entry added on open; the popstate above clears the selection.
  const close = useCallback(() => window.history.back(), []);

  // Previous and next stay within the list the open promo belongs to.
  function navFor(row: PromoRow): DetailNav {
    const group = row.status === "recommended" ? model.recommended : model.alternatives;
    const index = group.findIndex((item) => item.id === row.id);
    const before = group[index - 1];
    const after = group[index + 1];
    return {
      previous: before ? () => setSelectedId(before.id) : null,
      next: after ? () => setSelectedId(after.id) : null,
      noun: row.status === "recommended" ? "promo" : "alternative",
    };
  }

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
      onClose={close}
      closeLabel="Close"
      nav={navFor(selectedRow)}
    />
  ) : selectedGap ? (
    <UnevaluatedDetail
      key={selectedGap.id}
      row={selectedGap}
      cache={cache}
      headingRef={panelHeading}
      onClose={close}
      closeLabel="Close"
    />
  ) : null;

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="font-display text-4xl focus:outline-none sm:text-5xl"
          >
            Ranked promos
          </h1>
          <p className="mt-2 text-ink-muted [overflow-wrap:anywhere]">
            {job.fileName}
            {model.recommended.length
              ? ` · ${plural(model.recommended.length, "pick")}, best first`
              : ""}
          </p>
        </div>
        {total > 0 ? (
          <ExportControls service={service} jobId={job.id} missingNote={missingNote} />
        ) : null}
      </header>

      <p className="mt-4 text-sm text-ink-muted">
        These picks were evaluated by AI and checked against the script. No person has rated them,
        and the editorial score does not predict views.
      </p>

      {model.partial ? (
        <div role="note" className="mt-6 rounded-md border border-accent-ink/60 px-4 py-3 text-sm">
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
        <div className="mt-8">
          <EmptyState title="No promos passed the checks" headingLevel="h2">
            PromoLens read this show, but no moment had a strong enough opening, ending, and clarity
            for a new viewer.
            <span className="mt-4 block">
              <Button onClick={onStartOver}>Analyze another file</Button>
            </span>
          </EmptyState>
        </div>
      ) : (
        <>
          <RecommendedList
            rows={model.recommended}
            activeId={selectedId}
            onOpen={setSelectedId}
            cardRef={cardRef}
          />

          <div className="mt-12 space-y-6 border-t border-line pt-6">
            {model.alternatives.length ? (
              <details onToggle={(event) => setAlternativesOpen(event.currentTarget.open)}>
                <summary className="cursor-pointer font-semibold">
                  Alternatives ({model.alternatives.length})
                </summary>
                <p className="mt-2 text-sm text-ink-muted">
                  These passed every check but did not make the list, often because they repeat a
                  recommended moment.
                </p>
                {alternativesOpen ? (
                  <ol className="mt-4 space-y-3">
                    {model.alternatives.map((row) => (
                      <li key={row.id}>
                        <PromoCard
                          row={row}
                          selected={row.id === selectedId}
                          onOpen={setSelectedId}
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
                activeId={selectedId}
                onOpen={setSelectedId}
                cardRef={cardRef}
              />
            ) : null}

            {model.notAssessed > 0 ? (
              <p className="text-sm text-ink-muted">
                {plural(model.notAssessed, "other moment")} did not look strong enough on a first
                read to evaluate in detail.
              </p>
            ) : null}

            <AboutAnalysis results={results} />

            <div>
              <Button variant="quiet" onClick={onStartOver}>
                Analyze another file
              </Button>
            </div>
          </div>
        </>
      )}

      {detail ? <DetailShell onDismiss={close}>{detail}</DetailShell> : null}
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
    <section aria-labelledby="recommended-heading" className="mt-8">
      <h2 id="recommended-heading" className="sr-only">
        Recommended ({rows.length})
      </h2>
      {rows.length ? (
        <ol className="space-y-4">
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
        <p className="text-sm text-ink-muted">Nothing could be recommended from this run.</p>
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
    <section aria-labelledby="unevaluated-heading">
      <h2 id="unevaluated-heading" className="font-semibold">
        Could not be evaluated ({rows.length})
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        These have no score. They were not rejected, so they are worth a look yourself.
      </p>
      <ul className="mt-3 divide-y divide-line border-y border-line">
        {rows.map((row) => {
          const first = row.segments[0];
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm">
              <span className="min-w-0 flex-1 tabular-nums">
                {first
                  ? `Episode ${first.episode} · ${formatRange(first.startMs, first.endMs)}`
                  : row.id}{" "}
                · {formatSeconds(row.durationMs)}
                <span className="ml-2 text-danger">
                  {row.reason === "provider-refused"
                    ? "AI provider declined to review"
                    : "Evaluation failed"}
                </span>
              </span>
              <button
                ref={cardRef(row.id)}
                type="button"
                onClick={() => onOpen(row.id)}
                aria-current={row.id === activeId ? "true" : undefined}
                className="cursor-pointer rounded-sm font-medium text-accent-ink underline underline-offset-4 hover:no-underline"
              >
                Read the script{" "}
                <span className="sr-only">
                  for unevaluated moment:{" "}
                  {first
                    ? `Episode ${first.episode} · ${formatRange(first.startMs, first.endMs)}`
                    : row.id}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
