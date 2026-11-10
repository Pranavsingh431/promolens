import { z } from "zod";

import { startAnalysis } from "@/server/analyses";
import { RATES, editorRoute, json, readJson } from "@/server/http";
import { listJobs, toAnalysisJob } from "@/server/jobs";

export const runtime = "nodejs";

export const GET = editorRoute({}, async ({ backend, editor }) =>
  json({ analyses: await listJobs(backend.db, editor.id, new Date()) }),
);

const startSchema = z.object({ showId: z.uuid() });

export const POST = editorRoute({ write: true, rate: RATES.analyses }, async (context) => {
  const { backend, editor, request } = context;
  const { showId } = await readJson(request, startSchema);
  const { job, show, created } = await startAnalysis(backend, editor, showId);
  return json({ job: toAnalysisJob(job, show, new Date()) }, { status: created ? 201 : 200 });
});
