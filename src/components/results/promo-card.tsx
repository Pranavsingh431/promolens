import { memo } from "react";

import { formatSeconds, joinClasses } from "@/client/format";
import type { PromoRow } from "@/client/results-model";
import type { Note } from "@/client/wording";

/** At most this many items on a card. The rest wait in the detail view. */
const CARD_NOTES = 3;

/** Things an editor should act on before posting: review flags first, then serious warnings. */
export function attentionNotes(row: PromoRow): Note[] {
  return [...row.review, ...row.warnings.filter((w) => w.severity !== "minor")];
}

export function describeWhere(row: PromoRow): string {
  return row.promo.segments
    .map((s, index) => `${index > 0 ? "then " : ""}Episode ${s.episode} · ${s.start} to ${s.end}`)
    .join(", ");
}

type PromoCardProps = {
  row: PromoRow;
  selected: boolean;
  onOpen: (id: string) => void;
  /** Lets the results screen return focus here when the detail view closes. */
  buttonRef?: (element: HTMLButtonElement | null) => void;
};

/**
 * One recommendation, readable at a glance: where it is, what it opens and
 * ends on, and why it works. Scores and full assessments wait in the detail.
 */
function PromoCardBase({ row, selected, onOpen, buttonRef }: PromoCardProps) {
  const { promo, status, displayRank, repeatOf } = row;
  const notes = attentionNotes(row).slice(0, CARD_NOTES);
  const segments = promo.segments.length;
  const name = status === "recommended" ? `promo ${displayRank}` : `alternative ${displayRank}`;

  return (
    <article
      className={joinClasses(
        "relative rounded-lg border bg-surface p-5 transition-colors hover:border-line-strong sm:p-6",
        "has-[button:focus-visible]:outline-2 has-[button:focus-visible]:outline-offset-2 has-[button:focus-visible]:outline-accent-ink",
        selected ? "border-accent-ink" : "border-line",
      )}
    >
      <div className="flex gap-4 sm:gap-5">
        <span
          aria-hidden="true"
          className={joinClasses(
            "w-6 shrink-0 font-semibold leading-none tabular-nums",
            status === "recommended" ? "text-2xl" : "text-lg text-ink-muted",
          )}
        >
          {displayRank}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink-muted tabular-nums">
            {describeWhere(row)}
            {segments > 1 ? ` · ${segments} segments` : ""} · {formatSeconds(promo.durationMs)}
          </p>
          <h3 className="mt-1.5 text-lg leading-snug font-medium [overflow-wrap:anywhere]">
            {promo.whyItWorks}
          </h3>

          <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[4.5rem_minmax(0,1fr)]">
            <dt className="text-ink-muted">Hook</dt>
            <dd className="[overflow-wrap:anywhere]">{promo.hook.explanation}</dd>
            <dt className="mt-1 text-ink-muted sm:mt-0">Ends on</dt>
            <dd className="[overflow-wrap:anywhere]">{promo.cliffhanger.explanation}</dd>
          </dl>

          {repeatOf ? (
            <p className="mt-3 text-sm text-ink-muted">
              {repeatOf.rank ? `Repeats recommendation ${repeatOf.rank}` : "Repeats another promo"}
            </p>
          ) : null}
          {notes.length ? (
            <p className="mt-3 text-sm text-accent-ink">
              <span className="font-semibold">Check before posting:</span>{" "}
              {notes.map((note) => note.label).join(" · ")}
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <button
              ref={buttonRef}
              type="button"
              onClick={() => onOpen(row.id)}
              aria-current={selected ? "true" : undefined}
              className="cursor-pointer rounded-sm text-sm font-medium text-accent-ink underline-offset-4 after:absolute after:inset-0 after:rounded-lg hover:underline focus-visible:outline-none"
            >
              View clip details <span className="sr-only">for {name}</span>
            </button>
            <p className="text-xs text-ink-muted">
              Editorial score{" "}
              <span className="font-medium text-ink tabular-nums">
                {promo.editorialScore.toFixed(1)}
              </span>
            </p>
          </div>
        </div>
      </div>
    </article>
  );
}

export const PromoCard = memo(PromoCardBase);
