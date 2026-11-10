import { z } from "zod";

/**
 * Editorial review rubric. Ratings are ordinal (0 to 4). They describe how an
 * editor judged a clip; they are not a prediction of views or virality.
 *
 * The first three criteria come straight from the brief and are essential. A
 * clip can only be kept when every essential criterion is rated 2 or higher,
 * so a clip a new viewer cannot follow can never be kept or rated excellent.
 */

export const RUBRIC_VERSION = "1.0";

export const CRITERIA = [
  {
    id: "hook",
    name: "First-three-second hook",
    essential: true,
    question: "Would the first three seconds stop someone who is scrolling?",
    levels: [
      "Nothing happens in the first three seconds, or the clip opens mid-transition.",
      "Something is happening, but it would not stop a scroll.",
      "A clear point of interest appears within three seconds.",
      "A striking line, action, or reveal lands within three seconds.",
      "An arresting moment opens the clip: a slap, a shock, a cutting line.",
    ],
  },
  {
    id: "cliffhanger",
    name: "Unresolved ending",
    essential: true,
    question: "Does the clip cut at a moment that leaves the viewer needing more?",
    levels: [
      "It ends on a resolved or neutral moment.",
      "It ends with a faint open question.",
      "It ends on a clear unanswered question.",
      "It cuts at high tension with an obvious unanswered question.",
      "It cuts at the peak. A viewer would badly want the next second.",
    ],
  },
  {
    id: "clarity",
    name: "Makes sense on its own",
    essential: true,
    question: "Could someone who has never seen the show follow it?",
    levels: [
      "A new viewer could not follow what is happening.",
      "Confusing: who these people are or what is at stake is unclear.",
      "The basic situation is clear, though some details are lost.",
      "Who is involved, the conflict, and the stakes are clear.",
      "Completely self-contained and clear in one viewing.",
    ],
  },
  {
    id: "emotion",
    name: "Emotional pull",
    essential: false,
    question: "How strongly does the clip make the viewer feel something?",
    levels: [
      "Flat. No feeling comes through.",
      "Mild interest.",
      "Clear emotion, such as anger, hurt, fear, or desire.",
      "Strong emotion that builds.",
      "Intense, gripping emotion throughout.",
    ],
  },
  {
    id: "boundaries",
    name: "Clean start and end",
    essential: false,
    question: "Do the start and end points fall in the right places?",
    levels: [
      "Starts or ends mid-line or mid-action in a way that breaks the clip.",
      "One edge is clearly awkward.",
      "Both edges work but feel slightly early or late.",
      "Clean start and end on natural cut points.",
      "Edges feel deliberate. Nothing to trim or extend.",
    ],
  },
] as const;

export type CriterionId = (typeof CRITERIA)[number]["id"];
export const ESSENTIAL_CRITERIA: readonly CriterionId[] = ["hook", "cliffhanger", "clarity"];
export const KEEP_MINIMUM = 2;

export const KEEP_REASONS = [
  "strong-hook",
  "strong-cliffhanger",
  "clear-story",
  "emotional-peak",
  "all-round",
] as const;

export const REJECT_REASONS = [
  "no-hook",
  "resolved-ending",
  "needs-context",
  "bad-boundaries",
  "flat",
  "duplicate",
  "unsuitable-for-ads",
  "other",
] as const;

export const WEAKNESSES = [
  "slow-start",
  "weak-ending",
  "unclear-characters",
  "unclear-stakes",
  "cuts-mid-line",
  "too-long",
  "spoiler",
  "unsuitable-for-ads",
] as const;

const rating = z.number().int().min(0).max(4);

export const ratingsSchema = z.object({
  hook: rating,
  cliffhanger: rating,
  clarity: rating,
  emotion: rating,
  boundaries: rating,
});

export const judgmentSchema = z
  .object({
    ratings: ratingsSchema,
    decision: z.enum(["keep", "reject"]),
    mainReason: z.enum([...KEEP_REASONS, ...REJECT_REASONS]),
    weaknesses: z.array(z.enum(WEAKNESSES)),
    notes: z.string().max(1000),
  })
  .superRefine((judgment, ctx) => {
    if (judgment.decision === "keep") {
      for (const id of ESSENTIAL_CRITERIA) {
        if (judgment.ratings[id] < KEEP_MINIMUM) {
          ctx.addIssue({
            code: "custom",
            path: ["ratings", id],
            message: `A kept clip needs ${id} rated ${KEEP_MINIMUM} or higher. Reject it, or raise the rating if the clip meets it.`,
          });
        }
      }
    }
    const reasons: readonly string[] = judgment.decision === "keep" ? KEEP_REASONS : REJECT_REASONS;
    if (!reasons.includes(judgment.mainReason)) {
      ctx.addIssue({
        code: "custom",
        path: ["mainReason"],
        message: `"${judgment.mainReason}" is not a reason to ${judgment.decision} a clip.`,
      });
    }
    if (new Set(judgment.weaknesses).size !== judgment.weaknesses.length) {
      ctx.addIssue({ code: "custom", path: ["weaknesses"], message: "Weaknesses repeat." });
    }
  });

export type Ratings = z.infer<typeof ratingsSchema>;
export type Judgment = z.infer<typeof judgmentSchema>;
export type Overall = "reject" | "usable" | "strong" | "excellent";

/**
 * Overall assessment, derived from the ratings so it cannot drift from them.
 * - reject: the reviewer rejected the clip.
 * - usable: kept; the weakest essential criterion is rated 2.
 * - strong: kept; every essential criterion is rated 3 or higher.
 * - excellent: strong, at least two essential criteria are rated 4, and the
 *   boundaries are rated 3 or higher.
 */
export function overallAssessment(judgment: Judgment): Overall {
  if (judgment.decision === "reject") return "reject";
  const essentials = ESSENTIAL_CRITERIA.map((id) => judgment.ratings[id]);
  if (Math.min(...essentials) < 3) return "usable";
  const fours = essentials.filter((value) => value === 4).length;
  return fours >= 2 && judgment.ratings.boundaries >= 3 ? "excellent" : "strong";
}

/** Graded relevance used by nDCG: reject 0, usable 1, strong 2, excellent 3. */
export function relevanceGain(judgment: Judgment): 0 | 1 | 2 | 3 {
  return ({ reject: 0, usable: 1, strong: 2, excellent: 3 } as const)[overallAssessment(judgment)];
}
