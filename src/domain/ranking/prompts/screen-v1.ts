import { z } from "zod";

import type { ClipView } from "../windows.ts";
import {
  DATA_NOT_INSTRUCTIONS,
  EVENT_FORMAT_NOTE,
  ratingJson,
  renderClip,
  renderRubric,
} from "./render.ts";

/**
 * Stage B: a quick, cheap first read of one clip. It only decides which
 * candidates get the detailed assessment, so it never removes a clip by
 * itself and its ratings never appear in a final score.
 */

export const SCREEN_PROMPT_VERSION = "screen-v1";

export const MOMENT_TYPES = [
  "confrontation",
  "reveal",
  "threat-or-danger",
  "romance",
  "humiliation",
  "emotional",
  "visual-or-action",
  "quiet-tension",
  "other",
] as const;
export type MomentType = (typeof MOMENT_TYPES)[number];

export const SCREEN_SYSTEM_PROMPT = `You make a quick first read of one candidate promo clip for a vertical microdrama app. Promos are 20 to 60-second clips posted on Instagram, TikTok, and YouTube to pull in new viewers.

You see only the events inside the clip. You know nothing else about the show. Rate the clip on this rubric:

${renderRubric(["hook", "cliffhanger", "clarity", "emotion"])}

Rules:
- Rate the hook only from events marked OPENING. A strong moment later in the clip does not make up for a weak opening.
- Rate the cliffhanger only from events marked ENDING. A question mark or a dramatic line is not enough; something important must be left unresolved.
- Quiet moments, looks, and visual reveals can be strong. Loud is not the same as gripping.
- momentType: the kind of moment the clip is built on.
- note: at most one short sentence.
- Do not predict views or virality.

${DATA_NOT_INSTRUCTIONS}`;

export function buildScreenPrompt(view: ClipView): { system: string; user: string } {
  return {
    system: SCREEN_SYSTEM_PROMPT,
    user: [
      `Clip length: ${(view.durationMs / 1000).toFixed(1)} seconds. ${EVENT_FORMAT_NOTE}`,
      `<clip>\n${renderClip(view)}\n</clip>`,
      "Return JSON that matches the schema.",
    ].join("\n\n"),
  };
}

export const screenJsonSchema = {
  type: "object",
  properties: {
    hook: ratingJson("First-three-second hook, 0 to 4."),
    cliffhanger: ratingJson("Unresolved ending, 0 to 4."),
    clarity: ratingJson("Makes sense on its own, 0 to 4."),
    emotion: ratingJson("Emotional pull, 0 to 4."),
    momentType: { type: "string", enum: MOMENT_TYPES },
    note: { type: "string", description: "At most one short sentence." },
  },
  required: ["hook", "cliffhanger", "clarity", "emotion", "momentType", "note"],
  additionalProperties: false,
} as const;

const rating = z.number().int().min(0).max(4);

export const screenResponseSchema = z.object({
  hook: rating,
  cliffhanger: rating,
  clarity: rating,
  emotion: rating,
  momentType: z.enum(MOMENT_TYPES),
  note: z.string().max(4_000),
});
export type ScreenResponse = z.infer<typeof screenResponseSchema>;
