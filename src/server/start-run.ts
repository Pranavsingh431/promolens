import { start } from "workflow/api";

import { analyzeShow } from "../workflows/analyze-show.ts";

export async function startAnalysisRun(jobId: string): Promise<void> {
  await start(analyzeShow, [jobId]);
}
