import { z } from "zod";

import { promoCountSchema } from "@/domain/ranking/plan";
import { requireOwnedJob, startAnalysis } from "@/server/analyses";
import { RATES, editorRoute, json, parseId, readJson } from "@/server/http";
import { toAnalysisJob } from "@/server/jobs";

export const runtime = "nodejs";

const moreSchema = z.object({ count: promoCountSchema });

/**
 * Asks for a different number of promos from a show already analyzed. It starts
 * an analysis for the new count, which reuses every cached discovery read and
 * model judgment, so only the extra work is paid for.
 */
export const POST = editorRoute<{ id: string }>(
  { write: true, rate: RATES.analyses },
  async ({ backend, editor, params, request }) => {
    const { count } = await readJson(request, moreSchema);
    const { job: earlier } = await requireOwnedJob(backend, editor, parseId(params.id));
    const { job, show, created } = await startAnalysis(backend, editor, earlier.showId, count);
    return json({ job: toAnalysisJob(job, show, new Date()) }, { status: created ? 201 : 200 });
  },
);
