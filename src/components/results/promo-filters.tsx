"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { joinClasses } from "@/client/format";
import {
  activeFilters,
  DURATION_BANDS,
  NO_FILTERS,
  RATING_MINIMUMS,
  SCORE_MINIMUMS,
  SORT_OPTIONS,
  withoutFilter,
  type Filters,
  type SortKey,
} from "@/client/promo-filters";
import { Button } from "@/components/ui/button";

type ToolbarProps = {
  query: string;
  onQuery: (query: string) => void;
  filters: Filters;
  onFilters: (filters: Filters) => void;
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  /** Episodes that appear in the results, so every choice can match something. */
  episodes: number[];
  hasMultiSegment: boolean;
  /** Recommended promos that match, and how many there are in all. */
  shown: number;
  total: number;
  onClearAll: () => void;
};

const plural = (n: number) => `${n} ${n === 1 ? "promo" : "promos"}`;

/**
 * Search, one Filters button, and one Sort menu above the ranked list. The
 * filter choices wait in a panel, so the list itself stays clean.
 */
export function PromoToolbar({
  query,
  onQuery,
  filters,
  onFilters,
  sort,
  onSort,
  episodes,
  hasMultiSegment,
  shown,
  total,
  onClearAll,
}: ToolbarProps) {
  const id = useId();
  const [panelOpen, setPanelOpen] = useState(false);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const active = activeFilters(filters);
  const narrowing = active.length > 0 || query.trim() !== "";

  const closePanel = () => {
    setPanelOpen(false);
    requestAnimationFrame(() => filtersButton.current?.focus());
  };

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-search`} className="sr-only">
          Search promos
        </label>
        <input
          id={`${id}-search`}
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search promos"
          autoComplete="off"
          className="h-9 min-w-0 flex-1 basis-48 rounded-sm border border-line-strong bg-surface px-3 text-sm placeholder:text-ink-muted"
        />
        <button
          ref={filtersButton}
          type="button"
          onClick={() => setPanelOpen(true)}
          aria-haspopup="dialog"
          className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-sm border border-line-strong bg-surface px-3 text-sm font-medium hover:bg-sunken"
        >
          Filters
          {active.length ? (
            <span className="rounded-full bg-accent px-1.5 text-xs leading-5 text-on-accent tabular-nums">
              {active.length}
              <span className="sr-only"> active</span>
            </span>
          ) : null}
        </button>
        <label htmlFor={`${id}-sort`} className="sr-only">
          Sort promos
        </label>
        <select
          id={`${id}-sort`}
          value={sort}
          onChange={(event) => onSort(event.target.value as SortKey)}
          className="h-9 cursor-pointer rounded-sm border border-line-strong bg-surface px-2 text-sm"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div
        className={joinClasses(
          "flex flex-wrap items-center gap-x-3 gap-y-2 text-sm",
          narrowing && "mt-3",
        )}
      >
        <p aria-live="polite" className={narrowing ? "text-ink-muted tabular-nums" : "sr-only"}>
          {narrowing ? `${shown} of ${plural(total)}` : ""}
        </p>
        {active.map((filter) => (
          <button
            key={filter.key}
            type="button"
            onClick={() => onFilters(withoutFilter(filters, filter.key))}
            aria-label={`Remove filter: ${filter.label}`}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line-strong px-2.5 py-0.5 text-xs hover:bg-sunken"
          >
            {filter.label}
            <span aria-hidden="true">×</span>
          </button>
        ))}
        {narrowing ? (
          <Button variant="quiet" onClick={onClearAll}>
            Clear all
          </Button>
        ) : null}
      </div>

      {panelOpen ? (
        <FilterPanel
          filters={filters}
          onFilters={onFilters}
          episodes={episodes}
          hasMultiSegment={hasMultiSegment}
          shown={shown}
          onClose={closePanel}
        />
      ) : null}
    </div>
  );
}

/**
 * A native modal dialog: a sheet from the bottom on a phone, a small panel on
 * a wide screen. Choices apply at once, so the count is always current.
 */
function FilterPanel({
  filters,
  onFilters,
  episodes,
  hasMultiSegment,
  shown,
  onClose,
}: {
  filters: Filters;
  onFilters: (filters: Filters) => void;
  episodes: number[];
  hasMultiSegment: boolean;
  shown: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onFilters({ ...filters, [key]: value });
  const toggle = <T,>(list: readonly T[], value: T) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  const ratingChoices = RATING_MINIMUMS.map((n) => ({
    value: n,
    label: n === 4 ? "4 of 4" : `${n}+ of 4`,
  }));

  return (
    <dialog
      ref={dialog}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-0 mt-auto max-h-[85dvh] w-full max-w-none overflow-y-auto overscroll-contain rounded-t-lg border border-line bg-surface text-ink shadow-raised backdrop:bg-[rgb(18_16_13/0.45)] sm:m-auto sm:max-w-lg sm:rounded-lg"
    >
      <div className="px-5 pt-5 pb-4 sm:px-6">
        <h2 id={headingId} className="font-display text-2xl">
          Filters
        </h2>

        <div className="mt-4 space-y-5">
          <Group legend="Episode">
            {episodes.map((episode) => (
              <Choice
                key={episode}
                type="checkbox"
                label={String(episode)}
                srLabel={`Episode ${episode}`}
                checked={filters.episodes.includes(episode)}
                onChange={() => set("episodes", toggle(filters.episodes, episode))}
              />
            ))}
          </Group>

          <Group legend="Length">
            {DURATION_BANDS.map((band) => (
              <Choice
                key={band.value}
                type="checkbox"
                label={band.label}
                checked={filters.durations.includes(band.value)}
                onChange={() => set("durations", toggle(filters.durations, band.value))}
              />
            ))}
          </Group>

          <Minimum
            legend="Editorial score"
            choices={SCORE_MINIMUMS.map((n) => ({ value: n, label: `${n}+` }))}
            value={filters.minScore}
            onChange={(value) => set("minScore", value)}
          />
          <Minimum
            legend="Hook strength"
            choices={ratingChoices}
            value={filters.minHook}
            onChange={(value) => set("minHook", value)}
          />
          <Minimum
            legend="Cliffhanger strength"
            choices={ratingChoices}
            value={filters.minCliffhanger}
            onChange={(value) => set("minCliffhanger", value)}
          />
          <Minimum
            legend="Standalone clarity"
            choices={ratingChoices}
            value={filters.minClarity}
            onChange={(value) => set("minClarity", value)}
          />

          <Group legend="Review">
            {(
              [
                ["any", "Any"],
                ["clear", "Nothing to check"],
                ["needs-check", "Needs a check"],
              ] as const
            ).map(([value, label]) => (
              <Choice
                key={value}
                type="radio"
                name="review"
                label={label}
                checked={filters.review === value}
                onChange={() => set("review", value)}
              />
            ))}
          </Group>

          {hasMultiSegment ? (
            <Group legend="Segments">
              {(
                [
                  ["any", "Any"],
                  ["single", "Single segment"],
                  ["multi", "Multi-segment"],
                ] as const
              ).map(([value, label]) => (
                <Choice
                  key={value}
                  type="radio"
                  name="segments"
                  label={label}
                  checked={filters.segments === value}
                  onChange={() => set("segments", value)}
                />
              ))}
            </Group>
          ) : null}
        </div>
      </div>

      <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-line bg-surface px-5 py-3 sm:px-6">
        <Button variant="quiet" onClick={() => onFilters(NO_FILTERS)}>
          Clear filters
        </Button>
        <Button onClick={onClose}>Show {plural(shown)}</Button>
      </div>
    </dialog>
  );
}

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-semibold">{legend}</legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

function Minimum({
  legend,
  choices,
  value,
  onChange,
}: {
  legend: string;
  choices: Array<{ value: number; label: string }>;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const name = useId();
  return (
    <Group legend={legend}>
      {[{ value: null, label: "Any" }, ...choices].map((choice) => (
        <Choice
          key={choice.label}
          type="radio"
          name={name}
          label={choice.label}
          checked={value === choice.value}
          onChange={() => onChange(choice.value)}
        />
      ))}
    </Group>
  );
}

function Choice({
  type,
  name,
  label,
  srLabel,
  checked,
  onChange,
}: {
  type: "checkbox" | "radio";
  name?: string;
  label: string;
  srLabel?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={joinClasses(
        "inline-flex min-w-9 cursor-pointer items-center justify-center rounded-sm border px-2.5 py-1 text-sm tabular-nums",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-ink",
        checked ? "border-accent-ink bg-sunken font-medium" : "border-line-strong hover:bg-sunken",
      )}
    >
      <input type={type} name={name} checked={checked} onChange={onChange} className="sr-only" />
      {srLabel ? (
        <>
          <span aria-hidden="true">{label}</span>
          <span className="sr-only">{srLabel}</span>
        </>
      ) : (
        label
      )}
    </label>
  );
}
