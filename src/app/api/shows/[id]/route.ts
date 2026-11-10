import { ApiError } from "@/server/api-error";
import { RATES, editorRoute, notFound, parseId } from "@/server/http";
import { deleteOwnedShow } from "@/server/retention";

export const runtime = "nodejs";

export const DELETE = editorRoute<{ id: string }>(
  { write: true, rate: RATES.retries },
  async ({ backend, editor, params }) => {
    const outcome = await deleteOwnedShow(backend, editor.id, parseId(params.id));
    if (outcome === "not-found") throw notFound();
    if (outcome === "busy") {
      throw new ApiError(409, "busy", "Stop the running analysis before deleting this show.");
    }
    return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
  },
);
