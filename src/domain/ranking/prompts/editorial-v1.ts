import { z } from "zod";

import { HOOK_TYPES } from "../../discovery/proposal.ts";
import type { ClipContext, ClipView } from "../windows.ts";
import {
  DATA_NOT_INSTRUCTIONS,
  EVENT_FORMAT_NOTE,
  REF_TEXT_MAX,
  ratingJson,
  refsJson,
  renderClip,
  renderContext,
  renderRubric,
} from "./render.ts";

/**
 * Stage D: detailed editorial scoring of one clip on the Phase 2 rubric. The
 * model sees the clip's events, with the opening and ending marked, and a few
 * events just outside each edge that the viewer never sees. Those outside
 * events exist only to judge the cut points and to propose a better start or
 * end. They carry no writer notes, no discovery reasons, and no scores.
 */

export const EDITORIAL_PROMPT_VERSION = "editorial-v1";

export const TENSION_TYPES = [
  "unanswered-question",
  "interrupted-reveal",
  "pending-decision",
  "escalating-confrontation",
  "impending-consequence",
  "none",
] as const;

export const FALSE_CLIFFHANGERS = [
  "none",
  "already-answered",
  "conflict-resolved",
  "no-clear-issue",
  "needs-off-screen-knowledge",
  "confusing-cut",
] as const;

export const START_ISSUES = [
  "clean",
  "mid-line",
  "mid-action",
  "before-the-hook",
  "unneeded-setup",
] as const;
export const END_ISSUES = [
  "clean",
  "mid-line",
  "mid-action",
  "before-the-peak",
  "after-the-peak",
] as const;

export const CONTENT_WARNINGS = [
  "needs-earlier-context",
  "unclear-characters",
  "spoiler",
  "violence",
  "intimacy",
] as const;

export const EDITORIAL_SYSTEM_PROMPT = `You are an experienced promo editor for a vertical microdrama app. You judge one candidate promo: a 20 to 60-second clip that will be posted on Instagram, TikTok, or YouTube to make strangers start the show. You only judge the clip exactly as cut. You never suggest captions, music, overlays, voice-over, or extra footage.

Rate it on this rubric:
${renderRubric(["hook", "cliffhanger", "emotion", "boundaries"])}

Hook (first 3 seconds):
- Judge only the events marked OPENING, at the clip's actual start. A strong moment at second 15 does not make up for a weak opening.
- Describe what a viewer sees and hears in those seconds, cite the OPENING events, and say whether it is a visual surprise, a line of dialogue, both, or neither.
- question: the specific question the opening makes a viewer ask. Empty if it raises none.
- needsPriorContext: true if the opening only grips someone who already knows the story.

Cliffhanger (final seconds):
- Judge only the events marked ENDING. Describe how the clip ends and cite those events.
- tension: what is left unresolved. A question mark or a dramatic line is not enough on its own.
- falseCliffhanger: use it when the question was already answered, the conflict resolved, nothing clear is left open, the ending only works with knowledge the clip does not give, or the cut confuses rather than intrigues. Otherwise "none".
- Never invent what happens next.

Emotion: cite the clip events that carry the feeling.

Boundaries: judge whether the start and the end fall in the right places. The events outside the clip (B refs before, A refs after) are never seen by the viewer. Use them only to judge the cut points.

correction: propose a different start or end only if the hook or the ending clearly works better from another event. startRef must be a clip (C) or before (B) reference whose start becomes the new start; endRef must be a clip (C) or after (A) reference whose end becomes the new end. Leave a field empty to keep that edge. The clip must stay 20 to 60 seconds long. A correction is checked by code and judged again from scratch; it never changes this rating.

whyItWorks: one line on why this clip could pull in a new viewer, or why it would not.
Do not predict views, retention, or virality.

${DATA_NOT_INSTRUCTIONS}`;

export function buildEditorialPrompt(
  view: ClipView,
  context: ClipContext,
): { system: string; user: string } {
  const outside = renderContext(context);
  return {
    system: EDITORIAL_SYSTEM_PROMPT,
    user: [
      `Clip length: ${(view.durationMs / 1000).toFixed(1)} seconds. ${EVENT_FORMAT_NOTE}`,
      `<context-before>\nNot in the clip. Shown only to judge the start point.\n${outside.before}\n</context-before>`,
      `<clip>\n${renderClip(view)}\n</clip>`,
      `<context-after>\nNot in the clip. Shown only to judge the end point.\n${outside.after}\n</context-after>`,
      "Return JSON that matches the schema.",
    ].join("\n\n"),
  };
}

export const editorialJsonSchema = {
  type: "object",
  properties: {
    hook: {
      type: "object",
      properties: {
        rating: ratingJson("First-three-second hook, 0 to 4."),
        opening: { type: "string", description: "What a viewer sees and hears first." },
        evidence: refsJson("OPENING events that carry the hook."),
        surprise: { type: "string", enum: ["visual", "dialogue", "both", "none"] },
        question: { type: "string", description: "The question the opening raises, or empty." },
        needsPriorContext: { type: "boolean" },
      },
      required: ["rating", "opening", "evidence", "surprise", "question", "needsPriorContext"],
      additionalProperties: false,
    },
    cliffhanger: {
      type: "object",
      properties: {
        rating: ratingJson("Unresolved ending, 0 to 4."),
        ending: { type: "string", description: "How the clip ends." },
        evidence: refsJson("ENDING events the clip cuts on."),
        tension: { type: "string", enum: TENSION_TYPES },
        falseCliffhanger: { type: "string", enum: FALSE_CLIFFHANGERS },
        reasonToContinue: {
          type: "string",
          description: "Why a viewer would want more, or empty.",
        },
      },
      required: ["rating", "ending", "evidence", "tension", "falseCliffhanger", "reasonToContinue"],
      additionalProperties: false,
    },
    emotion: {
      type: "object",
      properties: {
        rating: ratingJson("Emotional pull, 0 to 4."),
        evidence: refsJson("Clip events that carry the feeling."),
        note: { type: "string" },
      },
      required: ["rating", "evidence", "note"],
      additionalProperties: false,
    },
    boundaries: {
      type: "object",
      properties: {
        rating: ratingJson("Clean start and end, 0 to 4."),
        start: { type: "string", enum: START_ISSUES },
        end: { type: "string", enum: END_ISSUES },
        note: { type: "string" },
      },
      required: ["rating", "start", "end", "note"],
      additionalProperties: false,
    },
    hookKind: { type: "string", enum: HOOK_TYPES },
    whyItWorks: { type: "string", description: "One line." },
    warnings: { type: "array", items: { type: "string", enum: CONTENT_WARNINGS } },
    correction: {
      type: "object",
      properties: {
        propose: { type: "boolean" },
        startRef: { type: "string" },
        endRef: { type: "string" },
        reason: { type: "string" },
      },
      required: ["propose", "startRef", "endRef", "reason"],
      additionalProperties: false,
    },
  },
  required: [
    "hook",
    "cliffhanger",
    "emotion",
    "boundaries",
    "hookKind",
    "whyItWorks",
    "warnings",
    "correction",
  ],
  additionalProperties: false,
} as const;

const text = z
  .string()
  .trim()
  .max(REF_TEXT_MAX * 2);
const refs = z.array(z.string().trim().max(REF_TEXT_MAX)).max(500);
const rating = z.number().int().min(0).max(4);

export const editorialResponseSchema = z.object({
  hook: z.object({
    rating,
    opening: text,
    evidence: refs,
    surprise: z.enum(["visual", "dialogue", "both", "none"]),
    question: text,
    needsPriorContext: z.boolean(),
  }),
  cliffhanger: z.object({
    rating,
    ending: text,
    evidence: refs,
    tension: z.enum(TENSION_TYPES),
    falseCliffhanger: z.enum(FALSE_CLIFFHANGERS),
    reasonToContinue: text,
  }),
  emotion: z.object({ rating, evidence: refs, note: text }),
  boundaries: z.object({
    rating,
    start: z.enum(START_ISSUES),
    end: z.enum(END_ISSUES),
    note: text,
  }),
  hookKind: z.enum(HOOK_TYPES),
  whyItWorks: text,
  warnings: z.array(z.enum(CONTENT_WARNINGS)).max(50),
  correction: z.object({
    propose: z.boolean(),
    startRef: z.string().trim().max(REF_TEXT_MAX),
    endRef: z.string().trim().max(REF_TEXT_MAX),
    reason: text,
  }),
});
export type EditorialResponse = z.infer<typeof editorialResponseSchema>;
