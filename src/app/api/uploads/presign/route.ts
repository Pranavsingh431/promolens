import { issueSignedToken } from "@vercel/blob";
import { handleUploadPresigned, type HandleUploadPresignedBody } from "@vercel/blob/client";
import { z } from "zod";

import { MAX_ARCHIVE_BYTES } from "@/domain/screenplay/limits";
import { ApiError } from "@/server/api-error";
import { RATES, editorRoute, json, notFound, readJson } from "@/server/http";
import { UPLOAD_MINUTES, findOpenUploadByKey } from "@/server/uploads";

export const runtime = "nodejs";

const presignSchema = z.object({
  type: z.literal("blob.generate-presigned-url"),
  payload: z.object({
    pathname: z.string().min(1).max(300),
    // Live testing on 2026-11-10 showed the store enforces the size limit on
    // single uploads but not on multipart ones, so multipart is not offered.
    multipart: z.literal(false),
    clientPayload: z.string().max(2000).nullable(),
  }),
});

/**
 * Issues a short-lived upload URL for one exact object. The object's privacy
 * comes from the store, not from anything the browser sends, and it is checked
 * again when the upload is completed.
 */
export const POST = editorRoute({ write: true, rate: RATES.uploadSteps }, async (context) => {
  const { backend, editor, request } = context;
  if (backend.storage.kind !== "vercel-blob") throw notFound();
  const body = await readJson(request, presignSchema);
  const result = await handleUploadPresigned({
    body: body as HandleUploadPresignedBody,
    request,
    getSignedToken: async (pathname) => {
      const upload = await findOpenUploadByKey(backend, editor.id, pathname);
      if (!upload) throw new ApiError(404, "not-found", "That was not found.");
      const validUntil = Date.now() + UPLOAD_MINUTES * 60_000;
      const limits = {
        allowedContentTypes: ["application/zip"],
        maximumSizeInBytes: MAX_ARCHIVE_BYTES,
        validUntil,
      };
      const token = await issueSignedToken({ pathname, operations: ["put"], ...limits });
      return { token, urlOptions: { ...limits, addRandomSuffix: false, allowOverwrite: false } };
    },
  });
  return json(result);
});
