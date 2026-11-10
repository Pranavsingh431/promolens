"use client";

import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { CRITERIA, type CriterionId } from "@/domain/evaluation/rubric";
import type { Recommendation } from "@/domain/ranking/output";
import { formatRange, formatSeconds } from "@/client/format";
import type { PromoRow, UnevaluatedRow } from "@/client/results-model";
import { buildPromoTimeline } from "@/client/timeline-layout";
import { useEpisodes, type EpisodeCache } from "@/client/use-episodes";
import {
  CERTAINTY_LABEL,
  TIER_LABEL,
  describeLowered,
  describeMethod,
  describeTension,
} from "@/client/wording";
import { ScreenplayTimeline } from "@/components/timeline/screenplay-timeline";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { StatusPill } from "@/components/ui/status-pill";

import { ComparePromos } from "./compare-promos";

type Evidence = Recommendation["hook"]["evidence"];

type SharedDetailProps = {
  cache: EpisodeCache;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  closeLabel: string;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line px-5 py-4 sm:px-6">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-2 text-sm">{children}</div>
    </section>
  );
}

function DetailHeader({
  heading,
  sub,
  pills,
  headingRef,
  onClose,
  closeLabel,
}: {
  heading: string;
  sub: string;
  pills: ReactNode;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  closeLabel: string;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface px-5 py-4 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-xl leading-tight font-semibold focus:outline-none"
          >
            {heading}
          </h2>
          <p className="mt-0.5 font-mono text-xs text-ink-muted">{sub}</p>
        </div>
        <Button variant="secondary" onClick={onClose} className="shrink-0">
          {closeLabel}
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">{pills}</div>
    </header>
  );
}

function SegmentTable({ segments }: { segments: Recommendation["segments"] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Segments in the order they play</caption>
        <thead className="text-xs text-ink-muted">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">
              Order
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Episode
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Start
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              End
            </th>
            <th scope="col" className="py-1 font-medium">
              Length
            </th>
          </tr>
        </thead>
        <tbody className="font-mono text-xs">
          {segments.map((segment, index) => (
            <tr key={`${segment.episode}-${segment.startMs}`} className="border-t border-line">
              <td className="py-1.5 pr-3">{index + 1}</td>
              <td className="py-1.5 pr-3">{segment.episode}</td>
              <td className="py-1.5 pr-3">{segment.start}</td>
              <td className="py-1.5 pr-3">{segment.end}</td>
              <td className="py-1.5">{formatSeconds(segment.endMs - segment.startMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const KIND_LABEL = { dialogue: "Dialogue", action: "Action", sound: "Sound", camera: "Camera" };

function EvidenceList({
  items,
  label,
  onSelect,
}: {
  items: Evidence;
  label: string;
  onSelect: (eventId: string) => void;
}) {
  if (items.length === 0) {
    return <p className="mt-2 text-ink-muted">No script lines were cited for this.</p>;
  }
  return (
    <ul className="mt-2 space-y-1" aria-label={label}>
      {items.map((item) => (
        <li key={item.eventId}>
          <button
            type="button"
            onClick={() => onSelect(item.eventId)}
            className="w-full cursor-pointer rounded-sm border-l-2 border-accent-ink bg-sunken px-3 py-2 text-left hover:bg-accent/10"
          >
            <span className="sr-only">Show in the timeline: </span>
            <span className="block font-mono text-xs text-ink-muted">
              Episode {item.episode} · {item.start} to {item.end} ·{" "}
              {item.speaker ?? KIND_LABEL[item.kind]}
            </span>
            <span className="block [overflow-wrap:anywhere]">{item.text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ClarityAssessment({ clarity }: { clarity: Recommendation["standaloneClarity"] }) {
  const answers = [
    ["Who is involved", clarity.involved],
    ["What is happening", clarity.happening],
    ["What is at stake", clarity.stakes],
    ["What is left open", clarity.openQuestion],
  ] as const;
  return (
    <>
      <dl className="space-y-2">
        {answers.map(([label, answer]) => (
          <div key={label}>
            <dt className="flex items-center gap-2 font-medium">
              {label}
              <StatusPill tone={answer.certainty === "clear" ? "neutral" : "caution"}>
                {CERTAINTY_LABEL[answer.certainty]}
              </StatusPill>
            </dt>
            <dd className="mt-0.5 text-ink-muted [overflow-wrap:anywhere]">{answer.text}</dd>
          </div>
        ))}
      </dl>
      {clarity.missingContext.length ? (
        <div className="mt-3">
          <p className="font-medium">A new viewer would not know</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-muted">
            {clarity.missingContext.map((item) => (
              <li key={item.item} className="[overflow-wrap:anywhere]">
                {item.item}
                {item.essential ? (
                  <span className="font-medium text-accent-ink"> (essential)</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-3">
        <span className="font-medium">Would a new viewer care? </span>
        <span className="text-ink-muted">
          {{ yes: "Yes", somewhat: "Somewhat", no: "No" }[clarity.wouldCare]}
        </span>
      </p>
    </>
  );
}

function CriteriaScores({ criteria }: { criteria: Recommendation["criteria"] }) {
  return (
    <ul className="space-y-2">
      {CRITERIA.map(({ id, name }) => {
        const c = criteria[id as CriterionId];
        return (
          <li key={id}>
            <div className="flex items-center justify-between gap-3">
              <span>{name}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span aria-hidden="true" className="flex gap-0.5">
                  {[1, 2, 3, 4].map((step) => (
                    <span
                      key={step}
                      className={
                        step <= c.rating
                          ? "h-1.5 w-3 rounded-full bg-accent-ink"
                          : "h-1.5 w-3 rounded-full bg-line"
                      }
                    />
                  ))}
                </span>
                <span className="font-mono text-xs">{c.rating} of 4</span>
              </span>
            </div>
            {c.rating < c.raw ? (
              <p className="mt-0.5 text-xs text-ink-muted">
                Lowered from {c.raw}. {c.caps.map(describeLowered).join(" ")}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Provenance({ promo }: { promo: Recommendation }) {
  const pairwise = promo.ranking.pairwise;
  return (
    <details className="border-t border-line px-5 py-4 text-sm sm:px-6">
      <summary className="cursor-pointer font-semibold">How this clip was found and ranked</summary>
      <dl className="mt-2 space-y-2">
        <div>
          <dt className="font-medium">Found by</dt>
          <dd className="text-ink-muted">
            {promo.provenance.methods.map(describeMethod).join("; ")}
          </dd>
        </div>
        {promo.provenance.correction ? (
          <div>
            <dt className="font-medium">Adjusted cut</dt>
            <dd className="text-ink-muted [overflow-wrap:anywhere]">
              Evaluation suggested a different start or end. This version was judged again on its
              own. {promo.provenance.correction.reason}
            </dd>
          </div>
        ) : null}
        {pairwise ? (
          <div>
            <dt className="font-medium">Head-to-head comparisons</dt>
            <dd className="text-ink-muted">
              Won {pairwise.wins}, lost {pairwise.losses}, tied {pairwise.ties}
              {pairwise.refused ? `, and ${pairwise.refused} declined by the AI provider` : ""}.
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="font-medium">Evaluation</dt>
          <dd className="text-ink-muted">Complete. AI-evaluated, not rated by a person.</dd>
        </div>
        <div>
          <dt className="font-medium">Clip id</dt>
          <dd className="font-mono text-xs text-ink-muted [overflow-wrap:anywhere]">
            {promo.clipKey}
          </dd>
        </div>
      </dl>
    </details>
  );
}

function TimelineSection({
  cache,
  segments,
  hookIds,
  endingIds,
  selectedId,
  onSelect,
  evidence,
}: {
  cache: EpisodeCache;
  segments: ReadonlyArray<{ episode: number; startMs: number; endMs: number }>;
  hookIds: ReadonlySet<string>;
  endingIds: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (eventId: string) => void;
  /** Lines the explanation cites, checked here against the loaded script. */
  evidence: Evidence;
}) {
  const episodes = useEpisodes(
    cache,
    segments.map((s) => s.episode),
  );
  const timeline = useMemo(
    () => (episodes.status === "ready" ? buildPromoTimeline(episodes.episodes) : null),
    [episodes],
  );

  if (episodes.status === "loading") return <LoadingState label="Loading the script" />;
  if (episodes.status === "error" || !timeline) {
    return (
      <ErrorState
        title="The script could not be loaded"
        message="The explanation below is still available. Try loading the timeline again."
        action={
          episodes.status === "error" ? (
            <Button variant="secondary" onClick={episodes.retry}>
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  }

  const mismatched = evidence.filter((item) => timeline.event(item.eventId)?.text !== item.text);
  return (
    <>
      <ScreenplayTimeline
        timeline={timeline}
        segments={segments}
        hookIds={hookIds}
        endingIds={endingIds}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      {mismatched.length ? (
        <p role="note" className="mt-3 text-sm font-medium text-danger">
          {mismatched.length === 1
            ? "One cited line does not match the script."
            : `${mismatched.length} cited lines do not match the script.`}{" "}
          Trust the script over the explanation.
        </p>
      ) : null}
    </>
  );
}

export function PromoDetail({
  row,
  rows,
  cache,
  headingRef,
  onClose,
  closeLabel,
}: SharedDetailProps & { row: PromoRow; rows: readonly PromoRow[] }) {
  const { promo, status, displayRank, review, warnings } = row;
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const hookIds = useMemo(() => new Set(promo.hook.evidence.map((e) => e.eventId)), [promo]);
  const endingIds = useMemo(
    () => new Set(promo.cliffhanger.evidence.map((e) => e.eventId)),
    [promo],
  );
  const allEvidence = useMemo(
    () => [...promo.hook.evidence, ...promo.cliffhanger.evidence],
    [promo],
  );
  const first = promo.segments[0];
  const where =
    promo.segments.length > 1
      ? `${promo.segments.length} segments`
      : first
        ? `Episode ${first.episode} · ${first.start} to ${first.end}`
        : "";
  const timelineArea = useRef<HTMLDivElement>(null);
  const showInTimeline = (eventId: string) => {
    setSelectedEvent(eventId);
    timelineArea.current?.scrollIntoView({ block: "start" });
  };

  return (
    <div>
      <DetailHeader
        heading={status === "recommended" ? `Promo ${displayRank}` : "Alternative"}
        sub={`${where} · ${formatSeconds(promo.durationMs)} total`}
        headingRef={headingRef}
        onClose={onClose}
        closeLabel={closeLabel}
        pills={
          <>
            <StatusPill tone={status === "recommended" ? "accent" : "neutral"}>
              {status === "recommended" ? "Recommended" : "Alternative"}
            </StatusPill>
            <StatusPill>
              Editorial score {promo.editorialScore.toFixed(1)} · {TIER_LABEL[promo.tier]}
            </StatusPill>
            {review.length ? <StatusPill tone="caution">Needs review</StatusPill> : null}
          </>
        }
      />

      <div className="px-5 py-4 sm:px-6">
        <p className="text-base [overflow-wrap:anywhere]">{promo.whyItWorks}</p>
      </div>

      {review.length ? (
        <Section title="Check before posting">
          <ul className="space-y-1.5">
            {review.map((note) => (
              <li key={note.code}>
                <span className="font-medium">{note.label}. </span>
                <span className="text-ink-muted">{note.detail}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Where it is in the script">
        <SegmentTable segments={promo.segments} />
        <div ref={timelineArea} className="mt-4 scroll-mt-32">
          <TimelineSection
            cache={cache}
            segments={promo.segments}
            hookIds={hookIds}
            endingIds={endingIds}
            selectedId={selectedEvent}
            onSelect={setSelectedEvent}
            evidence={allEvidence}
          />
        </div>
      </Section>

      <Section title="The hook">
        <p className="[overflow-wrap:anywhere]">{promo.hook.explanation}</p>
        {promo.hook.question ? (
          <p className="mt-1 text-ink-muted [overflow-wrap:anywhere]">
            It makes a viewer ask: {promo.hook.question}
          </p>
        ) : null}
        <EvidenceList
          items={promo.hook.evidence}
          label="Script lines behind the hook"
          onSelect={showInTimeline}
        />
      </Section>

      <Section title="The ending">
        <p className="[overflow-wrap:anywhere]">{promo.cliffhanger.explanation}</p>
        <p className="mt-1 text-ink-muted [overflow-wrap:anywhere]">
          Left open: {describeTension(promo.cliffhanger.tension).toLowerCase()}.
          {promo.cliffhanger.reasonToContinue ? ` ${promo.cliffhanger.reasonToContinue}` : ""}
        </p>
        <EvidenceList
          items={promo.cliffhanger.evidence}
          label="Script lines behind the ending"
          onSelect={showInTimeline}
        />
      </Section>

      <Section title="Would a new viewer follow it?">
        <ClarityAssessment clarity={promo.standaloneClarity} />
      </Section>

      <Section title="Editorial score">
        <p className="mb-3 text-xs text-ink-muted">
          {promo.editorialScore.toFixed(1)} of 100, from AI ratings checked against the script. Not
          a prediction of views.
        </p>
        <CriteriaScores criteria={promo.criteria} />
      </Section>

      <Section title="Weak points and warnings">
        {warnings.length ? (
          <ul className="space-y-1.5">
            {warnings.map((note) => (
              <li key={note.code}>
                <span className="font-medium">{note.label}. </span>
                <span className="text-ink-muted">{note.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">No warnings for this clip.</p>
        )}
      </Section>

      <ComparePromos current={row} rows={rows} />
      <Provenance promo={promo} />
    </div>
  );
}

const NO_IDS: ReadonlySet<string> = new Set();

/** A moment with no judgment. Only the script can be shown, and that is said plainly. */
export function UnevaluatedDetail({
  row,
  cache,
  headingRef,
  onClose,
  closeLabel,
}: SharedDetailProps & { row: UnevaluatedRow }) {
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const first = row.segments[0];
  return (
    <div>
      <DetailHeader
        heading="Not evaluated"
        sub={`${first ? `Episode ${first.episode} · ${formatRange(first.startMs, first.endMs)} · ` : ""}${formatSeconds(row.durationMs)} total`}
        headingRef={headingRef}
        onClose={onClose}
        closeLabel={closeLabel}
        pills={
          <StatusPill tone="danger">
            {row.reason === "provider-refused"
              ? "AI provider declined to review"
              : "Evaluation failed"}
          </StatusPill>
        }
      />
      <div className="px-5 py-4 text-sm text-ink-muted sm:px-6">
        {row.reason === "provider-refused"
          ? "The AI provider's content filter declined this moment, so it has no score and no explanation. That is not a rejection, and filters can catch intense scenes that make good promos. Read it below and decide for yourself."
          : "Evaluation did not finish for this moment, so it has no score and no explanation. Read it below and decide for yourself."}
      </div>
      <Section title="Where it is in the script">
        <TimelineSection
          cache={cache}
          segments={row.segments}
          hookIds={NO_IDS}
          endingIds={NO_IDS}
          selectedId={selectedEvent}
          onSelect={setSelectedEvent}
          evidence={[]}
        />
      </Section>
    </div>
  );
}
