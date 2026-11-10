import type { AnalysisJob, JobState } from "../../src/domain/analysis-job";
import type { AnalysisService } from "../../src/client/service";
import { buildExportFile } from "../../src/client/export";
import { buildDemoResults } from "../../src/demo/results";
import { DEMO_SHOW } from "../../src/demo/show";

/** A controllable service for tests. Any method can be replaced to simulate a failure. */

export function job(state: JobState, overrides: Partial<AnalysisJob> = {}): AnalysisJob {
  return {
    id: "job-1",
    fileName: "show.zip",
    state,
    facts: {},
    failure: null,
    canCancel: false,
    pollAfterMs: 1,
    ...overrides,
  };
}

export function fakeService(
  states: readonly AnalysisJob[],
  overrides: Partial<AnalysisService> = {},
): AnalysisService {
  let index = 0;
  const results = buildDemoResults("complete");
  return {
    startAnalysis: async () => states[0] as AnalysisJob,
    getJob: async () => {
      index = Math.min(index + 1, states.length - 1);
      return states[index] as AnalysisJob;
    },
    cancelJob: async () => job("cancelled"),
    getResults: async () => results,
    getEpisode: async (_id, episode) => {
      const found = DEMO_SHOW.episodes.find((e) => e.number === episode);
      if (!found) throw new Error("missing");
      return found;
    },
    exportResults: async (_id, format) => buildExportFile(results, format),
    ...overrides,
  };
}

export const zipFile = (name = "show.zip", content = "pk") =>
  new File([content], name, { type: "application/zip" });
