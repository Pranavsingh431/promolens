import { readEpisode, requireOwnedJob } from "@/server/analyses";
import { RATES, REVALIDATE, editorRoute, json, notFound, parseId } from "@/server/http";

export const runtime = "nodejs";

/** One episode, loaded only when an editor inspects a clip from it. */
export const GET = editorRoute<{ id: string; number: string }>(
  { rate: RATES.reads },
  async ({ backend, editor, request, params }) => {
    if (!/^[1-9]\d{0,4}$/.test(params.number)) throw notFound();
    const { job, show } = await requireOwnedJob(backend, editor, parseId(params.id));
    // Parsed episodes never change, so the show and episode number identify the content.
    const tag = `"${show.id}-${params.number}"`;
    const headers = { etag: tag, vary: "Cookie", "cache-control": REVALIDATE };
    if (request.headers.get("if-none-match") === tag) {
      return new Response(null, { status: 304, headers });
    }
    if (job.state === "queued" || job.state === "validating") throw notFound();
    const episode = await readEpisode(backend, show, Number(params.number));
    return json({ episode }, { headers });
  },
);
