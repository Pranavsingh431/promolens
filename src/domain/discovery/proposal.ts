import { z } from "zod";

/**
 * What the discovery model must return for one episode. The JSON schema below
 * is sent to the provider as a structured-output contract; the Zod schema
 * re-checks every response locally, because providers enforce schemas
 * differently.
 *
 * Events are referred to by their number within the episode (the `seq` of the
 * canonical event). Deterministic code turns numbers into timestamps.
 *
 * The schema avoids numeric and length constraints because some providers'
 * strict modes reject them. Limits are enforced in Zod and in resolution.
 */

export const PROPOSAL_SCHEMA_VERSION = "proposals-1";

export const HOOK_TYPES = [
  "confrontation",
  "reveal",
  "betrayal",
  "threat",
  "humiliation",
  "emotional-reversal",
  "visual-surprise",
  "curiosity",
  "urgent-choice",
  "romance",
  "danger",
  "other",
] as const;

export const PROPOSAL_WARNINGS = [
  "needs-earlier-context",
  "resolves-before-end",
  "hook-after-first-seconds",
  "unclear-characters",
  "spoiler",
  "violence",
  "intimacy",
] as const;

/** Proposals beyond this many per episode are not used. */
export const MAX_PROPOSALS = 12;

const eventList = (description: string) => ({
  type: "array",
  items: { type: "integer" },
  description,
});

export const proposalJsonSchema = {
  type: "object",
  properties: {
    proposals: {
      type: "array",
      description: `Up to ${MAX_PROPOSALS} clips, strongest first. Fewer is fine. Never pad with weak clips.`,
      items: {
        type: "object",
        properties: {
          startEvent: { type: "integer", description: "Number of the event the clip starts with." },
          endEvent: { type: "integer", description: "Number of the event the clip ends with." },
          hookEvents: eventList("Events that make the first 3 seconds work."),
          cliffhangerEvents: eventList("Events the clip ends on."),
          supportingEvents: eventList("Other events a new viewer needs to follow the clip."),
          hookType: { type: "string", enum: HOOK_TYPES },
          hook: {
            type: "string",
            description: "One short sentence: why the opening stops a scroll.",
          },
          cliffhanger: {
            type: "string",
            description: "One short sentence: what is left unresolved.",
          },
          whyItWorks: {
            type: "string",
            description: "One short sentence: why this could pull in new viewers.",
          },
          contextNeeded: {
            type: "array",
            items: { type: "string" },
            description: "Facts a new viewer needs that the clip does not show. Empty if none.",
          },
          warnings: { type: "array", items: { type: "string", enum: PROPOSAL_WARNINGS } },
        },
        required: [
          "startEvent",
          "endEvent",
          "hookEvents",
          "cliffhangerEvents",
          "supportingEvents",
          "hookType",
          "hook",
          "cliffhanger",
          "whyItWorks",
          "contextNeeded",
          "warnings",
        ],
        additionalProperties: false,
      },
    },
    episodeNotes: {
      type: "string",
      description:
        "One sentence on what kinds of moments this episode offers, or why it offers few.",
    },
  },
  required: ["proposals", "episodeNotes"],
  additionalProperties: false,
} as const;

/**
 * Event numbers are judged during resolution, which rejects a proposal whose
 * start or end event does not exist and counts every unknown reference. The
 * schema sent to the model states no list length or number range, so this
 * check must not throw out a whole response for them either. The cap only
 * stops runaway output: a 60-second clip in the real pack can hold 57 events.
 * (A cap of 40 failed every attempt for one episode on 2026-11-10.)
 */
export const MAX_EVENT_REFS = 1_000;
const eventNumber = z.number().int();
const eventNumbers = z.array(eventNumber).max(MAX_EVENT_REFS);
const sentence = z.string().trim().min(1).max(600);

export const proposalSchema = z.object({
  startEvent: eventNumber,
  endEvent: eventNumber,
  hookEvents: eventNumbers,
  cliffhangerEvents: eventNumbers,
  supportingEvents: eventNumbers,
  hookType: z.enum(HOOK_TYPES),
  hook: sentence,
  cliffhanger: sentence,
  whyItWorks: sentence,
  contextNeeded: z.array(z.string().trim().max(300)).max(8),
  warnings: z.array(z.enum(PROPOSAL_WARNINGS)).max(PROPOSAL_WARNINGS.length),
});

export const proposalResponseSchema = z.object({
  proposals: z.array(proposalSchema).max(MAX_PROPOSALS * 2),
  episodeNotes: z.string().trim().max(600),
});

export type Proposal = z.infer<typeof proposalSchema>;
export type ProposalResponse = z.infer<typeof proposalResponseSchema>;
