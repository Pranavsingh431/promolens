import { ServiceError, type AnalysisService } from "./service";

/**
 * Used on the real workspace until Phase 6 adds a backend. Every call fails
 * honestly. No file leaves the browser and no result is ever made up.
 */
function unavailable(): Promise<never> {
  return Promise.reject(
    new ServiceError("unavailable", "Screenplay analysis is not connected in this build."),
  );
}

export const unavailableService: AnalysisService = {
  startAnalysis: unavailable,
  getJob: unavailable,
  cancelJob: unavailable,
  getResults: unavailable,
  getEpisode: unavailable,
  exportResults: unavailable,
};
