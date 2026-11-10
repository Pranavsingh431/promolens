"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { AnalysisJob } from "@/domain/analysis-job";
import { formatRange, formatSeconds } from "@/client/format";
import {
  activeFilters,
  episodesIn,
  NO_FILTERS,
  selectRows,
  type Filters,
  type SortKey,
} from "@/client/promo-filters";
import { buildResultsModel, type PromoRow, type UnevaluatedRow } from "@/client/results-model";
import type { AnalysisResults, AnalysisService } from "@/client/service";
import { createEpisodeCache } from "@/client/use-episodes";
import { MAX_PROMOS } from "@/domain/ranking/plan";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

import { AboutAnalysis } from "./about-analysis";
import { DetailShell } from "./detail-shell";
import { ExportControls } from "./export-controls";
import { PromoCard } from "./promo-card";
import { PromoDetail, UnevaluatedDetail, type DetailNav } from "./promo-detail";
import { PromoToolbar } from "./promo-filters";

type ResultsViewProps = {
  service: AnalysisService;
  job: AnalysisJob;
  results: AnalysisResults;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onStartOver: () => void;
  /** Offered only by a service that can rerun an analysis. */
  onRetry?: (() => void) | undefined;
  /** Asks the same show for more promos. Offered only by a service that can. */
  onRequestMore?: ((count: number) => void) | undefined;
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
  onRequestMore,
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
  // Search, filters, and order only change what is shown. Ranks and results stay as stored.
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<SortKey>("recommended");
  const deferredQuery = useDeferredValue(query);
  const recommended = useMemo(
    () => selectRows(model.recommended, deferredQuery, filters, sort),
    [model.recommended, deferredQuery, filters, sort],
  );
  const alternatives = useMemo(
    () => selectRows(model.alternatives, deferredQuery, filters, sort),
    [model.alternatives, deferredQuery, filters, sort],
  );
  const narrowing = deferredQuery.trim() !== "" || activeFilters(filters).length > 0;
  const clearAll = useCallback(() => {
    setQuery("");
    setFilters(NO_FILTERS);
  }, []);
  const episodes = useMemo(() => episodesIn(allRows), [allRows]);

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

  // Previous and next stay within the list the open promo belongs to, as it is shown.
  function navFor(row: PromoRow): DetailNav {
    const shown = row.status === "recommended" ? recommended : alternatives;
    const group = shown.some((item) => item.id === row.id)
      ? shown
      : row.status === "recommended"
        ? model.recommended
        : model.alternatives;
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
  const requested = job.facts.requested;
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
      {total > 0 || model.unevaluated.length > 0 ? (
        <div className="mb-6">
          <Button variant="secondary" onClick={onStartOver}>
            Analyze another file
          </Button>
        </div>
      ) : null}
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
            {requested
              ? ` · ${model.recommended.length} of ${requested} requested, best first`
              : model.recommended.length
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

      {requested && model.recommended.length < requested && total > 0 ? (
        <p role="note" className="mt-4 text-sm">
          You asked for {requested}. {model.recommended.length} distinct{" "}
          {model.recommended.length === 1 ? "clip" : "clips"} passed every quality check, so that is
          what you got. Nothing below the checks was added to make up the number.
        </p>
      ) : null}

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
          {allRows.length > 1 ? (
            <PromoToolbar
              query={query}
              onQuery={setQuery}
              filters={filters}
              onFilters={setFilters}
              sort={sort}
              onSort={setSort}
              episodes={episodes}
              hasMultiSegment={allRows.some((row) => row.promo.segments.length > 1)}
              shown={recommended.length}
              total={model.recommended.length}
              onClearAll={clearAll}
            />
          ) : null}

          {narrowing && recommended.length === 0 && model.recommended.length > 0 ? (
            <div className="mt-6">
              <EmptyState title="No promos match" headingLevel="h2">
                Try removing a filter or searching for something else.
                <span className="mt-4 block">
                  <Button variant="secondary" onClick={clearAll}>
                    Clear all
                  </Button>
                </span>
              </EmptyState>
            </div>
          ) : (
            <RecommendedList
              rows={recommended}
              activeId={selectedId}
              onOpen={setSelectedId}
              cardRef={cardRef}
              rankedOrder={sort === "recommended"}
            />
          )}

          <div className="mt-12 space-y-6 border-t border-line pt-6">
            {model.alternatives.length ? (
              <details onToggle={(event) => setAlternativesOpen(event.currentTarget.open)}>
                <summary className="cursor-pointer font-semibold">
                  Alternatives (
                  {narrowing
                    ? `${alternatives.length} of ${model.alternatives.length}`
                    : model.alternatives.length}
                  )
                </summary>
                <p className="mt-2 text-sm text-ink-muted">
                  These passed every check but did not make the list, often because they repeat a
                  recommended moment.
                </p>
                {alternativesOpen && narrowing && alternatives.length === 0 ? (
                  <p className="mt-4 text-sm text-ink-muted">No alternatives match.</p>
                ) : null}
                {alternativesOpen ? (
                  <ol className="mt-4 space-y-3">
                    {alternatives.map((row) => (
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

            {onRequestMore && requested && model.recommended.length >= requested ? (
              <RequestMore current={requested} onRequest={onRequestMore} />
            ) : null}

            <AboutAnalysis results={results} job={job} />
          </div>
        </>
      )}

      {detail ? <DetailShell onDismiss={close}>{detail}</DetailShell> : null}
    </>
  );
}

/** The same show again, for more promos. Everything already judged is reused. */
function RequestMore({
  current,
  onRequest,
}: {
  current: number;
  onRequest: (count: number) => void;
}) {
  const inputId = useId();
  const [text, setText] = useState(String(Math.min(MAX_PROMOS, current * 2)));
  const count = Number(text);
  const valid = Number.isInteger(count) && count > current && count <= MAX_PROMOS;
  return (
    <section aria-labelledby={`${inputId}-heading`}>
      <h2 id={`${inputId}-heading`} className="font-semibold">
        Need more promos?
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        This reuses everything already checked, so only the extra work takes time and money.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label htmlFor={inputId} className="text-sm">
          Number of promos
        </label>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={current + 1}
          max={MAX_PROMOS}
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="w-24 rounded-sm border border-line-strong bg-surface px-2.5 py-1.5 text-sm tabular-nums"
        />
        <Button variant="secondary" disabled={!valid} onClick={() => onRequest(count)}>
          {valid ? `Find ${count} promos` : "Find more promos"}
        </Button>
      </div>
      {valid ? null : (
        <p className="mt-1 text-sm text-danger">
          Choose a whole number from {current + 1} to {MAX_PROMOS}.
        </p>
      )}
    </section>
  );
}

function RecommendedList({
  rows,
  activeId,
  onOpen,
  cardRef,
  rankedOrder,
}: {
  rows: PromoRow[];
  activeId: string | null;
  onOpen: (id: string) => void;
  cardRef: (id: string) => (element: HTMLButtonElement | null) => void;
  /** The note about head-to-head comparisons only makes sense in ranked order. */
  rankedOrder: boolean;
}) {
  return (
    <section aria-labelledby="recommended-heading" className="mt-6">
      <h2 id="recommended-heading" className="sr-only">
        Recommended ({rows.length})
      </h2>
      {rows.length ? (
        <ol className="space-y-4">
          {rows.map((row, index) => (
            <li key={row.id}>
              {rankedOrder &&
              index > 0 &&
              row.promo.ranking.pairwise === null &&
              rows[index - 1]?.promo.ranking.pairwise !== null ? (
                <p className="mb-4 border-t border-line pt-4 text-sm text-ink-muted">
                  The promos above were compared head to head. From here on they are ordered by
                  their individual scores.
                </p>
              ) : null}
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
