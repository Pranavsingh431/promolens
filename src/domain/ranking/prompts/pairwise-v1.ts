import { z } from "zod";

import type { ClipView } from "../windows.ts";
import { DATA_NOT_INSTRUCTIONS, EVENT_FORMAT_NOTE, renderClip, renderRubric } from "./render.ts";

/**
 * Stage E: a head-to-head comparison of two finalists. Each clip shows only
 * its own events. Which clip appears first is decided by a seeded coin, and
 * some pairs are judged again in the other order to measure position bias.
 * A tie is allowed. The answer is a model opinion, not an audience measurement.
 */

export const PAIRWISE_PROMPT_VERSION = "pairwise-v1";

const CHOICE = ["A", "B", "tie"] as const;

export const PAIRWISE_SYSTEM_PROMPT = `You compare two candidate promo clips from the same vertical microdrama. Each is a 20 to 60-second clip that would be posted on social media to make strangers start the show.

Question: which clip would more effectively make someone who has never seen the show want to keep watching, and why?

Judge each clip only from its own events, as a stranger would see it. Use this rubric for both:
${renderRubric(["hook", "cliffhanger", "clarity", "emotion", "boundaries"])}

Rules:
- The hook must land in the events marked OPENING, and the cliffhanger in the events marked ENDING.
- Do not prefer a clip because it is longer, has more dialogue, has more violence, uses names that sound important, or is more intense without being clear.
- A clip a stranger cannot follow should not win on drama alone.
- Answer "tie" when neither clip is clearly better. Do not invent a difference.
- For each criterion, say which clip is better, or tie.
- reason: one or two sentences that name the deciding difference.

${DATA_NOT_INSTRUCTIONS}`;

export function buildPairwisePrompt(a: ClipView, b: ClipView): { system: string; user: string } {
  return {
    system: PAIRWISE_SYSTEM_PROMPT,
    user: [
      `${EVENT_FORMAT_NOTE} Clip A uses references A1, A2, and so on; clip B uses B1, B2, and so on.`,
      `<clip-a>\nClip A, ${(a.durationMs / 1000).toFixed(1)} seconds.\n${renderClip(a, "A")}\n</clip-a>`,
      `<clip-b>\nClip B, ${(b.durationMs / 1000).toFixed(1)} seconds.\n${renderClip(b, "B")}\n</clip-b>`,
      "Return JSON that matches the schema.",
    ].join("\n\n"),
  };
}

const choiceJson = { type: "string", enum: CHOICE } as const;

export const pairwiseJsonSchema = {
  type: "object",
  properties: {
    winner: choiceJson,
    margin: { type: "string", enum: ["slight", "clear", "strong"] },
    criteria: {
      type: "object",
      properties: {
        hook: choiceJson,
        cliffhanger: choiceJson,
        clarity: choiceJson,
        emotion: choiceJson,
        boundaries: choiceJson,
      },
      required: ["hook", "cliffhanger", "clarity", "emotion", "boundaries"],
      additionalProperties: false,
    },
    reason: { type: "string" },
  },
  required: ["winner", "margin", "criteria", "reason"],
  additionalProperties: false,
} as const;

const choice = z.enum(CHOICE);
export const pairwiseResponseSchema = z.object({
  winner: choice,
  margin: z.enum(["slight", "clear", "strong"]),
  criteria: z.object({
    hook: choice,
    cliffhanger: choice,
    clarity: choice,
    emotion: choice,
    boundaries: choice,
  }),
  reason: z.string().trim().max(4_000),
});
export type PairwiseResponse = z.infer<typeof pairwiseResponseSchema>;
