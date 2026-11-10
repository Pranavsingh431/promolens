"use client";

import type { AnalysisResults, AnalysisService } from "@/client/service";
import { Button } from "@/components/ui/button";

import { useExport } from "./export-controls";

/** Technical details for anyone who wants them, closed by default. */
export function AboutAnalysis({
  results,
  service,
  jobId,
}: {
  results: AnalysisResults;
  service: AnalysisService;
  jobId: string;
}) {
  const { ranking } = results;
  const { busy, status, download } = useExport(service, jobId);
  const rows: Array<[string, string]> = [
    ["Run", ranking.runId],
    ["Ranking version", `${ranking.versions.ranking} (${ranking.versions.configHash})`],
    [
      "Models",
      [
        ...new Set(Object.entries(ranking.versions.models).map(([stage, m]) => `${stage}: ${m}`)),
      ].join(", "),
    ],
    ["Episodes covered", String(ranking.scope.episodes.length)],
    ["Moments considered", String(ranking.counts.poolInScope ?? ranking.list.length)],
    ["Evaluated in detail", String(ranking.counts.assessed ?? 0)],
  ];
  return (
    <details className="mt-6 rounded-md border border-line px-4 py-3 text-sm">
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
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          disabled={busy !== null}
          onClick={() => void download("ranking-json")}
        >
          Download full report (JSON)
        </Button>
        <p role="status" className={status?.failed ? "text-danger" : "text-ink-muted"}>
          {status?.message ?? ""}
        </p>
      </div>
    </details>
  );
}
