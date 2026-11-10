import { z } from "zod";

import { DEFAULT_PROMOS, promoCountSchema } from "@/domain/ranking/plan";
import { startAnalysis } from "@/server/analyses";
import { RATES, editorRoute, json, readJson } from "@/server/http";
import { listJobs, toAnalysisJob } from "@/server/jobs";

export const runtime = "nodejs";

export const GET = editorRoute({}, async ({ backend, editor }) =>
  json({ analyses: await listJobs(backend.db, editor.id, new Date()) }),
);

const startSchema = z.object({ showId: z.uuid(), count: promoCountSchema.default(DEFAULT_PROMOS) });

export const POST = editorRoute({ write: true, rate: RATES.analyses }, async (context) => {
  const { backend, editor, request } = context;
  const { showId, count } = await readJson(request, startSchema);
  const { job, show, created } = await startAnalysis(backend, editor, showId, count);
  return json({ job: toAnalysisJob(job, show, new Date()) }, { status: created ? 201 : 200 });
});
