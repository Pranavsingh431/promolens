import { assertResultsReady, readResults, requireOwnedJob, resultsTag } from "@/server/analyses";
import { RATES, REVALIDATE, editorRoute, parseId } from "@/server/http";

export const runtime = "nodejs";

const encoder = new TextEncoder();

export const GET = editorRoute<{ id: string }>(
  { rate: RATES.reads },
  async ({ backend, editor, request, params }) => {
    const { job } = await requireOwnedJob(backend, editor, parseId(params.id));
    assertResultsReady(job);
    const headers = {
      etag: resultsTag(job),
      vary: "Cookie",
      "cache-control": REVALIDATE,
      "x-content-type-options": "nosniff",
    };
    if (request.headers.get("if-none-match") === headers.etag) {
      return new Response(null, { status: 304, headers });
    }
    const { ranking, promos } = await readResults(backend, job);
    // Streamed, because a buffered function response has a 4.5 MB limit.
    const parts = [
      encoder.encode('{"ranking":'),
      ranking,
      encoder.encode(',"promos":'),
      promos,
      encoder.encode("}"),
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    return new Response(body, { headers: { ...headers, "content-type": "application/json" } });
  },
);
