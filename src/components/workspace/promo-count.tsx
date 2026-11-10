"use client";

import { useEffect, useId, useState } from "react";

import { joinClasses } from "@/client/format";
import { summarizeZip, type ZipSummary } from "@/client/zip-summary";
import {
  describeCost,
  describeDuration,
  estimateAnalysis,
  type WorkProfile,
} from "@/domain/estimate";
import { DEFAULT_PROMOS, MAX_PROMOS } from "@/domain/ranking/plan";
import { Button } from "@/components/ui/button";

const PRESETS = [5, 10, 20, 50, 100] as const;

export type Summarize = (file: File) => Promise<ZipSummary | null>;

const plural = (n: number) => `${n} promo${n === 1 ? "" : "s"}`;

/**
 * How many promos to find, what that is likely to take, and the button that
 * starts it. More promos means more clips evaluated in detail, so the estimate
 * moves with the number.
 */
export function PromoCount({
  file,
  profile,
  summarize = summarizeZip,
  onFind,
}: {
  file: File;
  /** Null when this deployment cannot estimate (unmeasured models, or not connected). */
  profile: WorkProfile | null;
  summarize?: Summarize | undefined;
  onFind: (count: number) => void;
}) {
  const inputId = useId();
  const noteId = useId();
  const [text, setText] = useState(String(DEFAULT_PROMOS));
  // Kept with the file it describes, so a newly chosen file never shows the last one's estimate.
  const [read, setRead] = useState<{ file: File; summary: ZipSummary | null } | null>(null);

  useEffect(() => {
    let live = true;
    void summarize(file).then((summary) => {
      if (live) setRead({ file, summary });
    });
    return () => {
      live = false;
    };
  }, [file, summarize]);

  const summary: ZipSummary | null | "reading" = read?.file === file ? read.summary : "reading";
  const count = Number(text);
  const valid = Number.isInteger(count) && count >= 1 && count <= MAX_PROMOS;
  const estimate =
    valid && profile && summary && summary !== "reading"
      ? estimateAnalysis(profile, {
          episodes: summary.episodes,
          textKb: summary.textKb,
          requested: count,
        })
      : null;
  const blocked = !valid || estimate?.overBudget === "yes";

  let note: string;
  if (!valid) note = `Choose a whole number from 1 to ${MAX_PROMOS}.`;
  else if (!profile) note = "Time and cost estimates are not available for this setup.";
  else if (summary === "reading") note = "Working out time and cost.";
  else if (!summary) note = "Time and cost appear once the file has been read.";
  else if (!estimate?.timeMs || !estimate.costUsd)
    note = "Time and cost estimates are not available for these models.";
  else
    note = `${summary.episodes} episodes. Takes ${describeDuration(estimate.timeMs)}. Estimated AI cost ${describeCost(estimate.costUsd)}.`;

  const budget = profile ? `$${profile.budgetUsd.toFixed(2)}` : "";

  return (
    <div className="mt-6">
      <label htmlFor={inputId} className="text-sm font-medium">
        Number of promos
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Common choices" className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={count === preset}
              onClick={() => setText(String(preset))}
              className={joinClasses(
                "min-w-11 cursor-pointer rounded-sm border px-2.5 py-1.5 text-sm tabular-nums",
                count === preset
                  ? "border-ink bg-ink text-canvas"
                  : "border-line-strong bg-surface hover:bg-sunken",
              )}
            >
              {preset}
            </button>
          ))}
        </div>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_PROMOS}
          step={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-describedby={noteId}
          aria-invalid={valid ? undefined : true}
          className="w-24 rounded-sm border border-line-strong bg-surface px-2.5 py-1.5 text-sm tabular-nums"
        />
      </div>
      <p
        id={noteId}
        aria-live="polite"
        className={joinClasses("mt-2 text-sm", valid ? "text-ink-muted" : "text-danger")}
      >
        {note}
      </p>
      {estimate?.overBudget === "yes" ? (
        <p className="mt-1 text-sm font-medium text-danger">
          That many promos would cost more than the {budget} limit for one analysis. Ask for fewer.
        </p>
      ) : estimate?.overBudget === "maybe" ? (
        <p className="mt-1 text-sm text-accent-ink">
          This may reach the {budget} limit for one analysis, which stops it early with what it has
          found by then.
        </p>
      ) : (
        <p className="mt-1 text-xs text-ink-muted">
          More promos means more clips checked in detail, so more time and cost. You get only clips
          that pass every quality check, which can be fewer than you ask for.
        </p>
      )}
      <div className="mt-5">
        <Button onClick={() => onFind(count)} disabled={blocked} className="px-6 py-3 text-base">
          {valid ? `Find ${plural(count)}` : "Find promos"}
        </Button>
      </div>
    </div>
  );
}
