import { RATES, editorRoute, json, readJson } from "@/server/http";
import { createUpload, createUploadSchema } from "@/server/uploads";

export const runtime = "nodejs";

export const POST = editorRoute({ write: true, rate: RATES.uploads }, async (context) => {
  const { backend, editor, request } = context;
  const input = await readJson(request, createUploadSchema);
  const upload = await createUpload(backend, editor.id, input);
  return json(
    {
      uploadId: upload.id,
      // Vercel Functions cannot accept a body this large, so the browser sends it straight to storage.
      transport: backend.storage.kind === "vercel-blob" ? "direct" : "server",
      pathname: upload.storageKey,
    },
    { status: 201 },
  );
});
