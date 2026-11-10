import type { AnalysisJob, JobState } from "@/domain/analysis-job";
import { buildExportFile } from "@/client/export";
import { ServiceError, type AnalysisResults, type AnalysisService } from "@/client/service";

import { buildDemoResults } from "./results";
import type { DemoPace, DemoScenario } from "./scenarios";
import { DEMO_SHOW } from "./show";

export type { DemoPace, DemoScenario } from "./scenarios";

/**
 * A stand-in backend that plays a scripted job. Each poll moves one stage on.
 * The selected file is never read and never leaves the browser.
 */

const JOB_ID = "demo-job";
const FULL: readonly JobState[] = [
  "uploading",
  "validating",
  "parsing",
  "discovering",
  "evaluating",
  "ranking",
];

const FACTS: Partial<Record<JobState, AnalysisJob["facts"]>> = {
  discovering: { episodes: 3 },
  evaluating: { episodes: 3, moments: 11 },
  ranking: { episodes: 3, moments: 11 },
  completed: { episodes: 3, moments: 11 },
  partial: { episodes: 3, moments: 11 },
};

function script(scenario: DemoScenario): readonly JobState[] {
  if (scenario === "failed") return ["uploading", "validating", "parsing", "failed"];
  return [...FULL, scenario === "partial" ? "partial" : "completed"];
}

export function createDemoService(options: {
  scenario: DemoScenario;
  pace: DemoPace;
}): AnalysisService {
  const steps = script(options.scenario);
  const pollAfterMs = options.pace === "fast" ? 30 : 750;
  let position = 0;
  let cancelled = false;
  let fileName = "night-ferry-sample.zip";
  let requested: number | undefined;
  let results: AnalysisResults | null = null;

  function current(): AnalysisJob {
    const state: JobState = cancelled ? "cancelled" : (steps[position] ?? "completed");
    return {
      id: JOB_ID,
      fileName,
      state,
      facts: { ...(FACTS[state] ?? {}), ...(requested ? { requested } : {}) },
      failure:
        state === "failed" ? { code: "no-episodes", stage: "parsing", retryable: true } : null,
      canCancel: FULL.includes(state),
      pollAfterMs,
    };
  }

  const loadResults = () => (results ??= buildDemoResults(options.scenario));

  return {
    async startAnalysis(file, { count } = {}) {
      fileName = file.name;
      requested = count;
      position = 0;
      cancelled = false;
      return current();
    },
    async getJob() {
      if (!cancelled && position < steps.length - 1) position += 1;
      return current();
    },
    async cancelJob() {
      cancelled = true;
      return current();
    },
    async getResults() {
      return loadResults();
    },
    async getEpisode(_jobId, episode) {
      const found = DEMO_SHOW.episodes.find((e) => e.number === episode);
      if (!found) throw new ServiceError("not-found", "That episode is not in this show.");
      return found;
    },
    async exportResults(_jobId, format) {
      return buildExportFile(loadResults(), format);
    },
  };
}
