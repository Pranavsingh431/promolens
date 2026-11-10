"use client";

import type { AnalysisResults } from "@/client/service";
import type { AnalysisJob } from "@/domain/analysis-job";

const minutes = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} seconds` : `${(ms / 60_000).toFixed(1)} minutes`;

/** Technical details, and what the run measured, for anyone who wants them. Closed by default. */
export function AboutAnalysis({ results, job }: { results: AnalysisResults; job: AnalysisJob }) {
  const { ranking } = results;
  const { facts } = job;
  const counts = ranking.counts;
  const measured: Array<[string, string]> = [];
  if (facts.requested) measured.push(["Promos requested", String(facts.requested)]);
  measured.push(["Promos returned", String(ranking.shortlist.length)]);
  if (counts.eligible !== undefined) {
    measured.push(["Passed every quality check", String(counts.eligible)]);
  }
  if (counts.finalists !== undefined) {
    measured.push(["Compared head to head", String(counts.finalists)]);
  }
  if (facts.elapsedMs !== undefined) measured.push(["Analysis time", minutes(facts.elapsedMs)]);
  if (facts.costUsd) {
    measured.push([
      "AI cost",
      facts.costUsd.billed !== null
        ? `$${facts.costUsd.billed.toFixed(4)} billed`
        : `$${facts.costUsd.estimated.toFixed(4)} estimated from token counts`,
    ]);
  }
  const rows: Array<[string, string]> = [
    ...measured,
    ["Run", ranking.runId],
    ["Ranking version", `${ranking.versions.ranking} (${ranking.versions.configHash})`],
    [
      "Models",
      [
        ...new Set(Object.entries(ranking.versions.models).map(([stage, m]) => `${stage}: ${m}`)),
      ].join(", "),
    ],
    ["Episodes covered", String(ranking.scope.episodes.length)],
    ["Candidates discovered", String(counts.poolInScope ?? ranking.list.length)],
    ["Evaluated in detail", String(counts.assessed ?? 0)],
  ];
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium">About this analysis</summary>
      <dl className="mt-3 grid gap-x-4 gap-y-1.5 sm:grid-cols-[auto_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="[overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {ranking.notes.length ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-ink-muted">
          {ranking.notes.map((note) => (
            <li key={note} className="[overflow-wrap:anywhere]">
              {note}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
