import { z } from "zod";

import type { ClipView } from "../windows.ts";
import {
  DATA_NOT_INSTRUCTIONS,
  EVENT_FORMAT_NOTE,
  REF_TEXT_MAX,
  ratingJson,
  refsJson,
  renderClip,
  renderRubric,
} from "./render.ts";

/**
 * Stage C: an independent cold-viewer check. The model receives the events
 * inside one clip and nothing else: no logline, no writer notes, no episode
 * number, no other clips, no discovery reasons, no scores. It must answer six
 * questions, cite the events behind each answer, and say when it cannot tell.
 * Code then caps the clarity rating from those answers (see scoring.ts).
 */

export const COLD_VIEWER_PROMPT_VERSION = "cold-viewer-v1";

export const CERTAINTY = ["clear", "partial", "unclear"] as const;
export type Certainty = (typeof CERTAINTY)[number];

export const COLD_VIEWER_SYSTEM_PROMPT = `You are someone who has never seen this show. A short clip from it appears in your social feed. You see only the events inside the clip and know nothing else: not the title, not the characters, not what happened before or after.

Answer six questions about the clip as that viewer:
1. involved: Who appears to be involved, and how do they relate to each other?
2. happening: What is happening?
3. stakes: What appears to be at stake? What could someone win or lose?
4. openQuestion: What question is left unresolved when the clip ends?
5. missingContext: What would a new viewer need to know that the clip does not show? Mark an item essential only if the clip cannot be followed without it.
6. wouldCare: Would a new viewer understand enough to care what happens next?

For questions 1 to 4:
- certainty is "clear" when the clip shows it plainly, "partial" when you can only partly tell, and "unclear" when you cannot tell.
- evidence lists the clip references (such as C3) that show it. Cite only events inside this clip.
- Never fill a gap with a guess about the wider story. If you had to assume something, say so in guesses and lower the certainty. An honest "unclear" is far more useful than a confident invention.
- Use a character's name only if the name is spoken or shown in the clip. Otherwise describe them, for example "a young woman" or "the man in the suit".

Then rate how well the clip makes sense on its own:
${renderRubric(["clarity"])}

${DATA_NOT_INSTRUCTIONS}`;

export function buildColdViewerPrompt(view: ClipView): { system: string; user: string } {
  return {
    system: COLD_VIEWER_SYSTEM_PROMPT,
    user: [
      `Clip length: ${(view.durationMs / 1000).toFixed(1)} seconds. ${EVENT_FORMAT_NOTE}`,
      `<clip>\n${renderClip(view)}\n</clip>`,
      "Return JSON that matches the schema.",
    ].join("\n\n"),
  };
}

const answerJson = (description: string) => ({
  type: "object",
  description,
  properties: {
    text: { type: "string", description: "One or two short sentences. Empty if you cannot tell." },
    certainty: { type: "string", enum: CERTAINTY },
    evidence: refsJson("Clip references that show it."),
  },
  required: ["text", "certainty", "evidence"],
  additionalProperties: false,
});

export const coldViewerJsonSchema = {
  type: "object",
  properties: {
    involved: answerJson("Who appears to be involved."),
    happening: answerJson("What is happening."),
    stakes: answerJson("What appears to be at stake."),
    openQuestion: answerJson("What question remains unresolved at the end."),
    missingContext: {
      type: "array",
      description: "Facts a new viewer needs that the clip does not show. Empty if none.",
      items: {
        type: "object",
        properties: {
          item: { type: "string" },
          essential: { type: "boolean" },
        },
        required: ["item", "essential"],
        additionalProperties: false,
      },
    },
    wouldCare: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["yes", "somewhat", "no"] },
        reason: { type: "string", description: "One short sentence." },
      },
      required: ["verdict", "reason"],
      additionalProperties: false,
    },
    guesses: {
      type: "array",
      items: { type: "string" },
      description: "Anything you had to assume. Empty if nothing.",
    },
    clarity: ratingJson("Makes sense on its own, 0 to 4."),
  },
  required: [
    "involved",
    "happening",
    "stakes",
    "openQuestion",
    "missingContext",
    "wouldCare",
    "guesses",
    "clarity",
  ],
  additionalProperties: false,
} as const;

const text = z
  .string()
  .trim()
  .max(REF_TEXT_MAX * 2);
const refs = z.array(z.string().trim().max(REF_TEXT_MAX)).max(500);
const answer = z.object({ text, certainty: z.enum(CERTAINTY), evidence: refs });

export const coldViewerResponseSchema = z.object({
  involved: answer,
  happening: answer,
  stakes: answer,
  openQuestion: answer,
  missingContext: z.array(z.object({ item: text, essential: z.boolean() })).max(50),
  wouldCare: z.object({ verdict: z.enum(["yes", "somewhat", "no"]), reason: text }),
  guesses: z.array(text).max(50),
  clarity: z.number().int().min(0).max(4),
});
export type ColdViewerResponse = z.infer<typeof coldViewerResponseSchema>;
export type ColdViewerAnswer = z.infer<typeof answer>;
