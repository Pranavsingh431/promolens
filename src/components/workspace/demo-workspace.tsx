"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { AnalysisService } from "@/client/service";
import { LoadingState } from "@/components/ui/loading-state";
import type { DemoPace, DemoScenario } from "@/demo/scenarios";

import { summarizeZip } from "@/client/zip-summary";
import type { WorkProfile } from "@/domain/estimate";

import type { Summarize } from "./promo-count";
import { Workspace } from "./workspace";

const SAMPLE_NAME = "night-ferry-sample.zip";

const SCENARIOS: ReadonlyArray<{ id: DemoScenario; label: string }> = [
  { id: "complete", label: "Finished analysis" },
  { id: "partial", label: "Partly finished analysis" },
  { id: "empty", label: "No promos found" },
  { id: "failed", label: "Failed analysis" },
];

function sampleFile(): File {
  return new File(["made-up demo file"], SAMPLE_NAME, { type: "application/zip" });
}

/**
 * The demo route. Everything it shows is made up and comes from src/demo, which
 * only this route loads. It is labelled on screen and never touches a real file.
 */
/** The sample is not a real ZIP, so its size is given: the made-up show has 3 short episodes. */
const summarizeSample: Summarize = async (file) =>
  file.name === SAMPLE_NAME ? { episodes: 3, textKb: 8 } : summarizeZip(file);

export function DemoWorkspace({
  scenario,
  pace,
  estimateProfile = null,
}: {
  scenario: DemoScenario;
  pace: DemoPace;
  estimateProfile?: WorkProfile | null;
}) {
  const router = useRouter();
  const example = `${scenario}:${pace}`;
  const [loaded, setLoaded] = useState<{ example: string; service: AnalysisService } | null>(null);

  useEffect(() => {
    let live = true;
    void import("@/demo/service").then(({ createDemoService }) => {
      if (live) setLoaded({ example, service: createDemoService({ scenario, pace }) });
    });
    return () => {
      live = false;
    };
  }, [example, scenario, pace]);

  // The workspace keeps the service it starts with, so it must never start with the service of
  // the example shown before. Until the new one is ready, show the loading state instead.
  const service = loaded?.example === example ? loaded.service : null;

  return (
    <>
      <div className="border-b border-line bg-sunken">
        <div className="mx-auto flex max-w-workspace flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2 sm:px-6">
          <p className="text-sm">
            <span className="font-semibold">Demo.</span>{" "}
            <span className="text-ink-muted">
              A made-up show with made-up results. Nothing leaves your browser.
            </span>
          </p>
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            Example
            <select
              value={scenario}
              onChange={(event) => router.replace(`/demo?scenario=${event.target.value}`)}
              className="rounded-sm border border-line-strong bg-surface px-2 py-1 text-sm text-ink"
            >
              {SCENARIOS.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {service ? (
        <Workspace
          key={example}
          service={service}
          sampleFile={sampleFile}
          estimateProfile={estimateProfile}
          summarize={summarizeSample}
        />
      ) : (
        <main id="main" className="mx-auto max-w-2xl px-4 sm:px-6">
          <LoadingState label="Loading the demo" />
        </main>
      )}
    </>
  );
}
