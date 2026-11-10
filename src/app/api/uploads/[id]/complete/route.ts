import { RATES, editorRoute, json, parseId } from "@/server/http";
import { completeUpload } from "@/server/uploads";

export const runtime = "nodejs";

export const POST = editorRoute<{ id: string }>(
  { write: true, rate: RATES.uploadSteps },
  async ({ backend, editor, params }) => {
    const { show, duplicate } = await completeUpload(backend, editor.id, parseId(params.id));
    return json({ showId: show.id, episodes: show.episodeCount, duplicate });
  },
);
