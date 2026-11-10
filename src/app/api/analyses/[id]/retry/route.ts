import { retryAnalysis } from "@/server/analyses";
import { RATES, editorRoute, json, parseId } from "@/server/http";
import { toAnalysisJob } from "@/server/jobs";

export const runtime = "nodejs";

export const POST = editorRoute<{ id: string }>(
  { write: true, rate: RATES.retries },
  async ({ backend, editor, params }) => {
    const { job, show } = await retryAnalysis(backend, editor, parseId(params.id));
    return json({ job: toAnalysisJob(job, show, new Date()) });
  },
);
