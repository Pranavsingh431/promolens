import { attentionNotes, type PromoRow } from "./results-model";

/**
 * Search, filters, and display order for promos that are already ranked.
 * Everything here works on the stored results in the browser. It never asks
 * the server or a model for anything, and it never changes a promo or its rank.
 */

export type SortKey =
  "recommended" | "score" | "hook" | "cliffhanger" | "clarity" | "shortest" | "longest" | "episode";

export const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "recommended", label: "Recommended order" },
  { value: "score", label: "Highest editorial score" },
  { value: "hook", label: "Strongest hook" },
  { value: "cliffhanger", label: "Strongest cliffhanger" },
  { value: "clarity", label: "Highest standalone clarity" },
  { value: "shortest", label: "Shortest first" },
  { value: "longest", label: "Longest first" },
  { value: "episode", label: "Episode order" },
];

/** Whole seconds, so a band edge matches the duration an editor reads on the card. */
export const DURATION_BANDS = [
  { value: "20-30", label: "20–30 s", min: 0, max: 30 },
  { value: "31-45", label: "31–45 s", min: 31, max: 45 },
  { value: "46-60", label: "46–60 s", min: 46, max: Infinity },
] as const;
export type DurationBand = (typeof DURATION_BANDS)[number]["value"];

export const SCORE_MINIMUMS = [70, 80, 90] as const;
/** Criterion ratings run from 0 to 4. */
export const RATING_MINIMUMS = [3, 4] as const;

export type Filters = {
  episodes: number[];
  durations: DurationBand[];
  minScore: number | null;
  minHook: number | null;
  minCliffhanger: number | null;
  minClarity: number | null;
  review: "any" | "clear" | "needs-check";
  segments: "any" | "single" | "multi";
};

export const NO_FILTERS: Filters = {
  episodes: [],
  durations: [],
  minScore: null,
  minHook: null,
  minCliffhanger: null,
  minClarity: null,
  review: "any",
  segments: "any",
};

/** One entry per kind of filter in use, for the count on the Filters button and the chips. */
export function activeFilters(filters: Filters): Array<{ key: keyof Filters; label: string }> {
  const active: Array<{ key: keyof Filters; label: string }> = [];
  if (filters.episodes.length) {
    const list = [...filters.episodes].sort((a, b) => a - b).join(", ");
    active.push({
      key: "episodes",
      label: `${filters.episodes.length === 1 ? "Episode" : "Episodes"} ${list}`,
    });
  }
  if (filters.durations.length) {
    const labels = DURATION_BANDS.filter((b) => filters.durations.includes(b.value));
    active.push({ key: "durations", label: labels.map((b) => b.label).join(", ") });
  }
  if (filters.minScore !== null)
    active.push({ key: "minScore", label: `Score ${filters.minScore}+` });
  if (filters.minHook !== null)
    active.push({ key: "minHook", label: `Hook ${filters.minHook}+ of 4` });
  if (filters.minCliffhanger !== null)
    active.push({ key: "minCliffhanger", label: `Cliffhanger ${filters.minCliffhanger}+ of 4` });
  if (filters.minClarity !== null)
    active.push({ key: "minClarity", label: `Clarity ${filters.minClarity}+ of 4` });
  if (filters.review !== "any")
    active.push({
      key: "review",
      label: filters.review === "clear" ? "Nothing to check" : "Needs a check",
    });
  if (filters.segments !== "any")
    active.push({
      key: "segments",
      label: filters.segments === "single" ? "Single segment" : "Multi-segment",
    });
  return active;
}

export function withoutFilter(filters: Filters, key: keyof Filters): Filters {
  return { ...filters, [key]: NO_FILTERS[key] };
}

/** Episodes that appear in any segment of any row, in order. */
export function episodesIn(rows: readonly PromoRow[]): number[] {
  const set = new Set<number>();
  for (const row of rows) for (const s of row.promo.segments) set.add(s.episode);
  return [...set].sort((a, b) => a - b);
}

/** Total length across every segment, in whole seconds. */
function durationSeconds(row: PromoRow): number {
  const fromSegments = row.promo.segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  return Math.round((row.promo.durationMs || fromSegments) / 1000);
}

/** A missing or unreadable value, which sorts last and fails any minimum. */
const valueOf = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const rating = (row: PromoRow, id: "hook" | "cliffhanger" | "clarity") =>
  valueOf(row.promo.criteria?.[id]?.rating);

const atLeast = (value: number | null, minimum: number | null) =>
  minimum === null || (value !== null && value >= minimum);

type Prepared = { row: PromoRow; order: number; text: string; episodes: Set<number> };

function prepare(row: PromoRow, order: number): Prepared {
  const { promo } = row;
  return {
    row,
    order,
    episodes: new Set(promo.segments.map((s) => s.episode)),
    text: [
      promo.hook?.explanation,
      promo.cliffhanger?.explanation,
      promo.whyItWorks,
      promo.ranking?.reason,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase(),
  };
}

/**
 * Every word must match. "Episode 3", "ep 3", or a bare "3" means episode 3.
 */
function matchesQuery(item: Prepared, query: string): boolean {
  const words = query
    .toLowerCase()
    .replace(/\b(?:episode|ep)\.?\s*(\d+)\b/g, "$1")
    .split(/\s+/)
    .filter(Boolean);
  return words.every((word) =>
    /^\d+$/.test(word) ? item.episodes.has(Number(word)) : item.text.includes(word),
  );
}

function matchesFilters(item: Prepared, filters: Filters): boolean {
  const { row } = item;
  if (filters.episodes.length && !filters.episodes.some((e) => item.episodes.has(e))) return false;
  if (filters.durations.length) {
    const seconds = durationSeconds(row);
    const band = DURATION_BANDS.find((b) => seconds >= b.min && seconds <= b.max);
    if (!band || !filters.durations.includes(band.value)) return false;
  }
  if (!atLeast(valueOf(row.promo.editorialScore), filters.minScore)) return false;
  if (!atLeast(rating(row, "hook"), filters.minHook)) return false;
  if (!atLeast(rating(row, "cliffhanger"), filters.minCliffhanger)) return false;
  if (!atLeast(rating(row, "clarity"), filters.minClarity)) return false;
  if (filters.review !== "any") {
    const needsCheck = attentionNotes(row).length > 0;
    if (needsCheck !== (filters.review === "needs-check")) return false;
  }
  if (filters.segments !== "any") {
    const multi = row.promo.segments.length > 1;
    if (multi !== (filters.segments === "multi")) return false;
  }
  return true;
}

/** Higher first, missing values last. */
const desc = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;
const asc = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;

const firstSegment = (row: PromoRow) => row.promo.segments[0];

function compare(sort: SortKey, a: Prepared, b: Prepared): number {
  const ra = a.row;
  const rb = b.row;
  const score = () => desc(valueOf(ra.promo.editorialScore), valueOf(rb.promo.editorialScore));
  switch (sort) {
    case "recommended":
      return 0;
    case "score":
      return score();
    case "hook":
    case "cliffhanger":
    case "clarity":
      return desc(rating(ra, sort), rating(rb, sort)) || score();
    case "shortest":
      return asc(durationSeconds(ra), durationSeconds(rb));
    case "longest":
      return desc(durationSeconds(ra), durationSeconds(rb));
    case "episode": {
      const fa = firstSegment(ra);
      const fb = firstSegment(rb);
      return (
        asc(valueOf(fa?.episode), valueOf(fb?.episode)) ||
        asc(valueOf(fa?.startMs), valueOf(fb?.startMs))
      );
    }
  }
}

/**
 * The rows that match, in the chosen order. Ties keep the ranked order, and
 * each row keeps its own rank, so nothing about the ranking itself changes.
 */
export function selectRows(
  rows: readonly PromoRow[],
  query: string,
  filters: Filters,
  sort: SortKey,
): PromoRow[] {
  const trimmed = query.trim();
  const kept = rows
    .map(prepare)
    .filter((item) => (!trimmed || matchesQuery(item, trimmed)) && matchesFilters(item, filters));
  if (sort !== "recommended") kept.sort((a, b) => compare(sort, a, b) || a.order - b.order);
  return kept.map((item) => item.row);
}
