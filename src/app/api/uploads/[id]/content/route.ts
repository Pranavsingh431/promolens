import { MAX_ARCHIVE_BYTES } from "@/domain/screenplay/limits";
import { RATES, editorRoute, json, notFound, parseId } from "@/server/http";
import { findOpenUpload, readLimited } from "@/server/uploads";

export const runtime = "nodejs";

/** Only for local storage. On Vercel the browser uploads directly and this answers 404. */
export const PUT = editorRoute<{ id: string }>(
  { write: true, rate: RATES.uploadSteps },
  async ({ backend, editor, request, params }) => {
    if (backend.storage.kind === "vercel-blob") throw notFound();
    const upload = await findOpenUpload(backend, editor.id, parseId(params.id));
    if (!upload) throw notFound();
    const bytes = await readLimited(request.body, MAX_ARCHIVE_BYTES);
    await backend.storage.put(upload.storageKey, bytes, "application/zip");
    return json({ received: bytes.length });
  },
);
