import { memo } from "react";

import { formatSeconds, joinClasses } from "@/client/format";
import type { PromoRow } from "@/client/results-model";
import { TIER_LABEL } from "@/client/wording";
import { StatusPill } from "@/components/ui/status-pill";

/** At most this many warnings on a card. The rest wait in the detail view. */
const CARD_WARNINGS = 2;

type PromoCardProps = {
  row: PromoRow;
  selected: boolean;
  onOpen: (id: string) => void;
  /** Lets the results screen return focus here when the detail view closes. */
  buttonRef?: (element: HTMLButtonElement | null) => void;
};

function PromoCardBase({ row, selected, onOpen, buttonRef }: PromoCardProps) {
  const { promo, status, displayRank, review, warnings, repeatOf } = row;
  const shownWarnings = warnings.filter((w) => w.severity !== "minor").slice(0, CARD_WARNINGS);

  return (
    <article
      className={joinClasses(
        "relative rounded-md border bg-surface p-4 hover:border-line-strong",
        selected ? "border-accent-ink ring-1 ring-accent-ink" : "border-line",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={joinClasses(
            "w-7 shrink-0 font-mono leading-none font-medium",
            status === "recommended" ? "text-2xl" : "pt-0.5 text-lg text-ink-muted",
          )}
        >
          {displayRank}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-mono text-sm font-medium">
            <button
              ref={buttonRef}
              type="button"
              onClick={() => onOpen(row.id)}
              aria-current={selected ? "true" : undefined}
              className="cursor-pointer text-left after:absolute after:inset-0 after:rounded-md"
            >
              <span className="sr-only">
                Inspect {status === "recommended" ? "recommendation" : "alternative"} {displayRank}
                :{" "}
              </span>
              {promo.segments.map((segment, index) => (
                <span key={`${segment.episode}-${segment.startMs}`} className="block">
                  {index > 0 ? "then " : ""}Episode {segment.episode} · {segment.start} to{" "}
                  {segment.end}
                </span>
              ))}
            </button>
          </h3>
          <p className="font-mono text-xs text-ink-muted">
            {promo.segments.length > 1 ? `${promo.segments.length} segments · ` : ""}
            {formatSeconds(promo.durationMs)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-lg leading-none font-medium">
            {promo.editorialScore.toFixed(1)}
          </p>
          <p className="mt-1 text-xs text-ink-muted">Editorial score</p>
        </div>
      </div>

      <dl className="mt-3 space-y-1.5 text-sm">
        <div>
          <dt className="inline font-semibold">Hook. </dt>
          <dd className="inline text-ink-muted [overflow-wrap:anywhere]">
            {promo.hook.explanation}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold">Ends on. </dt>
          <dd className="inline text-ink-muted [overflow-wrap:anywhere]">
            {promo.cliffhanger.explanation}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold">Why. </dt>
          <dd className="inline text-ink-muted [overflow-wrap:anywhere]">{promo.whyItWorks}</dd>
        </div>
      </dl>

      <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Status and warnings">
        <li>
          <StatusPill tone={status === "recommended" ? "accent" : "neutral"}>
            {status === "recommended" ? "Recommended" : "Alternative"}
          </StatusPill>
        </li>
        <li>
          <StatusPill>{TIER_LABEL[promo.tier]}</StatusPill>
        </li>
        {repeatOf ? (
          <li>
            <StatusPill>
              {repeatOf.rank ? `Repeats recommendation ${repeatOf.rank}` : "Repeats another promo"}
            </StatusPill>
          </li>
        ) : null}
        {review.length ? (
          <li>
            <StatusPill tone="caution">Needs review: {review[0]?.label}</StatusPill>
          </li>
        ) : null}
        {shownWarnings.map((warning) => (
          <li key={warning.code}>
            <StatusPill tone={warning.severity === "important" ? "caution" : "neutral"}>
              {warning.label}
            </StatusPill>
          </li>
        ))}
      </ul>
    </article>
  );
}

export const PromoCard = memo(PromoCardBase);
