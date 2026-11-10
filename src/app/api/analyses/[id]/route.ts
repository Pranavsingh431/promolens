import { requireOwnedJob } from "@/server/analyses";
import { editorRoute, json, parseId } from "@/server/http";
import { toAnalysisJob } from "@/server/jobs";

export const runtime = "nodejs";

/** Called while an analysis runs. One indexed query, and nothing from the screenplay. */
export const GET = editorRoute<{ id: string }>({}, async ({ backend, editor, request, params }) => {
  const { job, show } = await requireOwnedJob(backend, editor, parseId(params.id));
  const tag = `"${job.id}-${job.revision}"`;
  if (request.headers.get("if-none-match") === tag) {
    return new Response(null, {
      status: 304,
      headers: { etag: tag, "cache-control": "private, no-store" },
    });
  }
  return json({ job: toAnalysisJob(job, show, new Date()) }, { headers: { etag: tag } });
});
