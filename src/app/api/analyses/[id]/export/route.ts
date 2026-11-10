import { z } from "zod";

import { buildExportFile } from "@/client/export";
import { promoExportSchema, rankingOutputSchema } from "@/domain/ranking/output";
import { readResults, requireOwnedJob } from "@/server/analyses";
import { ApiError } from "@/server/api-error";
import { NO_STORE, RATES, editorRoute, parseId } from "@/server/http";

export const runtime = "nodejs";

const formatSchema = z.enum(["promos-csv", "promos-json", "ranking-json"]);
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as unknown;

/** Builds the file from the stored results, using the same code as the demo download. */
export const GET = editorRoute<{ id: string }>(
  { rate: RATES.exports },
  async ({ backend, editor, request, params }) => {
    const format = formatSchema.safeParse(new URL(request.url).searchParams.get("format"));
    if (!format.success) throw new ApiError(400, "invalid-request", "That format is not offered.");
    const { job } = await requireOwnedJob(backend, editor, parseId(params.id));
    const stored = await readResults(backend, job);
    let file;
    try {
      file = buildExportFile(
        {
          ranking: rankingOutputSchema.parse(decode(stored.ranking)),
          promos: promoExportSchema.parse(decode(stored.promos)),
        },
        format.data,
      );
    } catch {
      throw new ApiError(500, "export-failed", "This export could not be built.");
    }
    return new Response(file.content, {
      headers: {
        "content-type": file.mimeType,
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "cache-control": NO_STORE,
        "x-content-type-options": "nosniff",
      },
    });
  },
);
