import { z } from "zod";

import { candidateSetSchema, type CandidateSet } from "../evaluation/candidate.ts";
import { CRITERIA, ESSENTIAL_CRITERIA, KEEP_MINIMUM } from "../evaluation/rubric.ts";
import { promoSchema } from "../promo.ts";
import { formatTimecode } from "../screenplay/timecode.ts";
import type { Assessment, ListStatus } from "./assemble.ts";
import type { Strength } from "./pairwise.ts";
import type { ClipEvent, ClipView } from "./windows.ts";

/**
 * The editor-facing result. Every recommendation carries ordered segments
 * with exact timestamps, the hook and cliffhanger with the source events
 * that show them, one line on why it works, the cold-viewer assessment,
 * every criterion with its caps, warnings, ranking metadata, and where the
 * clip came from. The editorial score is a ranking aid on the rubric, not a
 * probability of views or virality.
 */

export const RANKING_OUTPUT_FORMAT = 2;
export const PROMO_EXPORT_FORMAT = 1;

const ms = z.number().int().nonnegative();
const timecode = z.string().regex(/^\d{2,}:\d{2}\.\d{2}$/);
const rating = z.number().int().min(0).max(4);
const criterion = z.object({ rating, raw: rating, caps: z.array(z.string()) });

const evidenceSchema = z.object({
  ref: z.string().regex(/^C\d+$/),
  eventId: z.string().regex(/^E\d{3,}-\d{4,}$/),
  episode: z.number().int().positive(),
  kind: z.enum(["camera", "action", "sound", "dialogue"]),
  speaker: z.string().optional(),
  start: timecode,
  end: timecode,
  /** Seconds into the promo where the event is on screen. */
  promoStartS: z.number().nonnegative(),
  promoEndS: z.number().nonnegative(),
  text: z.string(),
});

const certainty = z.enum(["clear", "partial", "unclear"]);
const tiers = z.enum(["below-gate", "usable", "strong", "excellent"]);
const selectionReasons = z.enum([
  "priority",
  "episode-floor",
  "type-floor",
  "exploration",
  "screen-failed",
  "correction",
]);

export const recommendationSchema = z
  .object({
    rank: z.number().int().positive(),
    candidateId: z.string().min(1),
    clipKey: z.string().min(1),
    editorialScore: z.number().min(0).max(100),
    tier: tiers,
    segments: z
      .array(
        z.object({
          episode: z.number().int().positive(),
          startMs: ms,
          endMs: ms,
          start: timecode,
          end: timecode,
        }),
      )
      .min(1),
    durationMs: z.number().int().positive(),
    hook: z.object({
      explanation: z.string().min(1),
      question: z.string(),
      surprise: z.enum(["visual", "dialogue", "both", "none"]),
      evidence: z.array(evidenceSchema).min(1),
    }),
    cliffhanger: z.object({
      explanation: z.string().min(1),
      tension: z.string().min(1),
      reasonToContinue: z.string(),
      evidence: z.array(evidenceSchema).min(1),
    }),
    whyItWorks: z.string().min(1),
    standaloneClarity: z.object({
      rating,
      involved: z.object({ text: z.string(), certainty }),
      happening: z.object({ text: z.string(), certainty }),
      stakes: z.object({ text: z.string(), certainty }),
      openQuestion: z.object({ text: z.string(), certainty }),
      missingContext: z.array(z.object({ item: z.string(), essential: z.boolean() })),
      wouldCare: z.enum(["yes", "somewhat", "no"]),
      caps: z.array(z.string()),
    }),
    criteria: z.object({
      hook: criterion,
      cliffhanger: criterion,
      clarity: criterion,
      emotion: criterion,
      boundaries: criterion,
    }),
    warnings: z.array(z.string()),
    /** Why an editor should look at this clip before posting it. Empty when nothing stands out. */
    editorReview: z.array(z.string()),
    ranking: z.object({
      listPosition: z.number().int().positive(),
      scoreRank: z.number().int().positive(),
      pairwise: z
        .object({
          strength: z.number().positive(),
          wins: z.number().int().nonnegative(),
          losses: z.number().int().nonnegative(),
          ties: z.number().int().nonnegative(),
          comparisons: z.number().int().nonnegative(),
          /** Comparisons the provider refused, so they are missing from the record above. */
          refused: z.number().int().nonnegative(),
        })
        .nullable(),
      diversity: z.object({
        maxSimilarity: z.number().min(0).max(1),
        nearest: z.string().nullable(),
      }),
      reason: z.string().min(1),
    }),
    provenance: z.object({
      methods: z.array(z.string()),
      sourceCandidate: z.string().nullable(),
      selection: selectionReasons,
      correction: z
        .object({
          from: z.string(),
          startRef: z.string().nullable(),
          endRef: z.string().nullable(),
          reason: z.string(),
        })
        .nullable(),
    }),
  })
  .superRefine((rec, ctx) => {
    // The brief's hard limits, through the existing promo contract.
    const parsed = promoSchema.safeParse({
      id: rec.candidateId,
      rank: rec.rank,
      segments: rec.segments.map(({ episode, startMs, endMs }) => ({ episode, startMs, endMs })),
      hook: rec.hook.explanation,
      cliffhanger: rec.cliffhanger.explanation,
      whyItWorks: rec.whyItWorks,
      rankReason: rec.ranking.reason,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
    }
    const total = rec.segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
    if (total !== rec.durationMs) {
      ctx.addIssue({
        code: "custom",
        path: ["durationMs"],
        message: "Duration does not match segments",
      });
    }
    for (const e of rec.hook.evidence) {
      if (e.promoStartS >= 3) {
        ctx.addIssue({
          code: "custom",
          path: ["hook", "evidence"],
          message: `${e.ref} starts after the first 3 s`,
        });
      }
    }
    for (const e of rec.cliffhanger.evidence) {
      if (e.promoEndS < rec.durationMs / 1000 - 3) {
        ctx.addIssue({
          code: "custom",
          path: ["cliffhanger", "evidence"],
          message: `${e.ref} ends before the final 3 s`,
        });
      }
    }
  });
export type Recommendation = z.infer<typeof recommendationSchema>;

const listEntrySchema = z.object({
  position: z.number().int().positive(),
  candidateId: z.string(),
  clipKey: z.string(),
  status: z.enum([
    "finalist",
    "eligible",
    "below-gate",
    "not-assessed",
    "provider-refused",
    "assessment-failed",
    "removed",
  ]),
  /** Whether detailed judgments exist, separate from where the clip landed. */
  evaluation: z.enum(["complete", "not-run", "provider-refused", "failed", "removed"]),
  /** True when no judgment exists for this clip and an editor has to look at it directly. */
  manualReview: z.boolean(),
  editorialScore: z.number().nullable(),
  tier: tiers.nullable(),
  ratings: z
    .object({
      hook: rating,
      cliffhanger: rating,
      clarity: rating,
      emotion: rating,
      boundaries: rating,
    })
    .nullable(),
  screeningPriority: z.number().nullable(),
  selection: selectionReasons.nullable(),
  flags: z.array(z.string()),
  reasons: z.array(z.string()),
  derivedFrom: z.string().nullable(),
});

export const rankingOutputSchema = z.object({
  format: z.literal(RANKING_OUTPUT_FORMAT),
  runId: z.string(),
  createdAt: z.string(),
  packSha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["complete", "partial"]),
  scope: z.object({ label: z.string(), episodes: z.array(z.number().int().positive()) }),
  versions: z.object({
    ranking: z.string(),
    configHash: z.string(),
    rubric: z.string(),
    prompts: z.record(z.string(), z.string()),
    models: z.record(z.string(), z.string()),
  }),
  config: z.unknown(),
  counts: z.record(z.string(), z.number()),
  shortlist: z.array(recommendationSchema),
  alternates: z.array(
    z.object({
      candidateId: z.string(),
      listPosition: z.number().int().positive(),
      redundantWith: z.string(),
      similarity: z.number(),
      basis: z.string(),
    }),
  ),
  list: z.array(listEntrySchema),
  /** Everything that could not be judged. A refusal is a provider decision, not a low score. */
  incomplete: z.object({
    refusedClips: z.array(
      z.object({
        candidateId: z.string(),
        clipKey: z.string(),
        stage: z.enum(["screen", "detailed"]),
        kind: z.string(),
      }),
    ),
    refusedComparisons: z.array(
      z.object({
        pairId: z.string(),
        first: z.string(),
        second: z.string(),
        replicate: z.number().int().nonnegative(),
      }),
    ),
    failedClips: z.array(z.string()),
  }),
  positionBias: z.object({
    judgments: z.number().int().nonnegative(),
    ties: z.number().int().nonnegative(),
    firstShownWinShare: z.number().nullable(),
    positionPValue: z.number().nullable(),
    repeatedPairs: z.number().int().nonnegative(),
    consistent: z.number().int().nonnegative(),
    reversed: z.number().int().nonnegative(),
    reversedTowardSecond: z.number().int().nonnegative(),
    reversedTowardFirst: z.number().int().nonnegative(),
  }),
  notes: z.array(z.string()),
});
export type RankingOutput = z.infer<typeof rankingOutputSchema>;

/**
 * Every promo that passed the essential gates, with full detail, for the
 * brief's "find the promos across all episodes". The shortlist is the first
 * ten of these an editor should read; this file holds the rest.
 */
export const promoExportSchema = z.object({
  format: z.literal(PROMO_EXPORT_FORMAT),
  runId: z.string(),
  createdAt: z.string(),
  packSha256: z.string().regex(/^[0-9a-f]{64}$/),
  rankingVersion: z.string(),
  configHash: z.string(),
  status: z.enum(["complete", "partial"]),
  note: z.string(),
  promos: z.array(
    z.object({
      shortlistRank: z.number().int().positive().nullable(),
      alternateOf: z.string().nullable(),
      promo: recommendationSchema,
    }),
  ),
});
export type PromoExport = z.infer<typeof promoExportSchema>;

/**
 * One piece of evidence. Times are the part of the event that is on screen in
 * the promo, in episode time, so an event already running at a cut starts at
 * the cut. The full event stays findable by its id.
 */
function evidence(
  event: ClipEvent,
  segments: ReadonlyArray<{ startMs: number; endMs: number }>,
): z.infer<typeof evidenceSchema> {
  const segment = segments[event.segment];
  const from = segment ? Math.max(event.sourceStartMs, segment.startMs) : event.sourceStartMs;
  const to = segment ? Math.min(event.sourceEndMs, segment.endMs) : event.sourceEndMs;
  return {
    ref: event.ref,
    eventId: event.eventId,
    episode: event.episode,
    kind: event.kind,
    ...(event.speaker ? { speaker: event.speaker } : {}),
    start: formatTimecode(from),
    end: formatTimecode(to),
    promoStartS: event.startMs / 1000,
    promoEndS: event.endMs / 1000,
    text: event.text,
  };
}

const comparable = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Text in double quotes that the clip's events do not contain. A guard against invented lines. */
export function quotesNotInClip(texts: readonly string[], view: ClipView): string[] {
  const clip = comparable(view.events.map((e) => e.text).join(" "));
  return texts
    .flatMap((text) => [...text.matchAll(/[“"]([^”"]+)[”"]/g)].map((m) => m[1] as string))
    .filter((quote) => {
      const words = comparable(quote);
      return words.length > 0 && !clip.includes(words);
    });
}

function modelText(a: Assessment): string[] {
  const e = a.editorial;
  const c = a.cold;
  if (!e || !c) return [];
  return [
    e.hook.opening,
    e.hook.question,
    e.cliffhanger.ending,
    e.cliffhanger.reasonToContinue,
    e.whyItWorks,
    c.involved.text,
    c.happening.text,
    c.stakes.text,
    c.openQuestion.text,
  ];
}

/** Warnings an editor should see: structural, cut lines, model content warnings, and caps. */
export function warningsFor(a: Assessment): string[] {
  const warnings = new Set<string>(a.stageA.flags);
  for (const w of a.editorial?.warnings ?? []) warnings.add(w);
  if (a.editorial?.hook.needsPriorContext) warnings.add("hook-needs-prior-context");
  if (a.editorial && a.editorial.cliffhanger.falseCliffhanger !== "none") {
    warnings.add(`possible-false-cliffhanger:${a.editorial.cliffhanger.falseCliffhanger}`);
  }
  for (const m of a.cold?.missingContext ?? [])
    if (m.essential) warnings.add("essential-context-missing");
  if (a.clarity?.unsupported.length) warnings.add("cold-viewer-claims-without-evidence");
  if (a.editorialResult?.invalidRefs.length || a.clarity?.invalidRefs.length) {
    warnings.add("model-cited-unknown-events");
  }
  if (a.editorialResult?.outOfWindowRefs.length) warnings.add("model-cited-events-outside-window");
  if (quotesNotInClip(modelText(a), a.stageA.view).length) warnings.add("model-quote-not-in-clip");
  return [...warnings].sort();
}

/** Why an editor should look before posting. Reasons only: ratings never change here. */
export function editorReviewReasons(
  a: Assessment,
  gateMinimum: number,
  refusedComparisons: number,
): string[] {
  const s = a.scored;
  if (!s) return [];
  return [
    ...ESSENTIAL_CRITERIA.filter((id) => s.ratings[id] <= gateMinimum).map(
      (id) => `${id}-at-the-minimum`,
    ),
    ...(refusedComparisons > 0 ? [`comparison-refused:${refusedComparisons}`] : []),
  ];
}

function evaluationOf(status: ListStatus): z.infer<typeof listEntrySchema>["evaluation"] {
  switch (status) {
    case "finalist":
    case "eligible":
    case "below-gate":
      return "complete";
    case "not-assessed":
      return "not-run";
    case "provider-refused":
      return "provider-refused";
    case "assessment-failed":
      return "failed";
    case "removed":
      return "removed";
  }
}

export function rankReason(
  rank: number,
  a: Assessment,
  scoreRank: number,
  strength: Strength | null,
): string {
  const s = a.scored;
  if (!s) return `Rank ${rank}.`;
  const parts = [
    `Rank ${rank}: editorial score ${s.score.toFixed(1)} of 100 (${s.tier}; hook ${s.ratings.hook}, cliffhanger ${s.ratings.cliffhanger}, clarity ${s.ratings.clarity}).`,
  ];
  if (strength && strength.comparisons > 0) {
    parts.push(
      `Head to head: won ${strength.wins}, lost ${strength.losses}, tied ${strength.ties} of ${strength.comparisons}.`,
    );
  }
  if (scoreRank !== rank) parts.push(`Individual score order: ${scoreRank}.`);
  return parts.join(" ");
}

/** Builds and validates one recommendation. Throws if any required evidence is missing. */
export function buildRecommendation(input: {
  rank: number;
  assessment: Assessment;
  listPosition: number;
  scoreRank: number;
  strength: Strength | null;
  diversity: { maxSimilarity: number; nearest: string | null };
  refusedComparisons?: number;
  gateMinimum?: number;
}): Recommendation {
  const a = input.assessment;
  const e = a.editorial;
  const c = a.cold;
  const s = a.scored;
  const er = a.editorialResult;
  const cl = a.clarity;
  if (!e || !c || !s || !er || !cl) throw new Error(`${a.candidate.id} was not fully assessed.`);
  const refused = input.refusedComparisons ?? 0;
  const methods = a.candidate.cues
    .filter((cue) => cue.startsWith("src:"))
    .map((cue) => cue.slice(4))
    .sort();
  return recommendationSchema.parse({
    rank: input.rank,
    candidateId: a.candidate.id,
    clipKey: a.candidate.clipKey,
    editorialScore: s.score,
    tier: s.tier,
    segments: a.candidate.segments.map((seg) => ({
      episode: seg.episode,
      startMs: seg.startMs,
      endMs: seg.endMs,
      start: formatTimecode(seg.startMs),
      end: formatTimecode(seg.endMs),
    })),
    durationMs: a.candidate.durationMs,
    hook: {
      explanation: e.hook.opening || "(no description given)",
      question: e.hook.question,
      surprise: e.hook.surprise,
      evidence: er.evidence.hook.map((e) => evidence(e, a.candidate.segments)),
    },
    cliffhanger: {
      explanation: e.cliffhanger.ending || "(no description given)",
      tension: e.cliffhanger.tension,
      reasonToContinue: e.cliffhanger.reasonToContinue,
      evidence: er.evidence.cliffhanger.map((e) => evidence(e, a.candidate.segments)),
    },
    whyItWorks: e.whyItWorks || "(no line given)",
    standaloneClarity: {
      rating: cl.rating,
      involved: { text: c.involved.text, certainty: cl.certainty.involved },
      happening: { text: c.happening.text, certainty: cl.certainty.happening },
      stakes: { text: c.stakes.text, certainty: cl.certainty.stakes },
      openQuestion: { text: c.openQuestion.text, certainty: cl.certainty.openQuestion },
      missingContext: c.missingContext,
      wouldCare: c.wouldCare.verdict,
      caps: cl.caps,
    },
    criteria: {
      hook: er.hook,
      cliffhanger: er.cliffhanger,
      clarity: { rating: cl.rating, raw: cl.raw, caps: cl.caps },
      emotion: er.emotion,
      boundaries: er.boundaries,
    },
    warnings: warningsFor(a),
    editorReview: editorReviewReasons(a, input.gateMinimum ?? KEEP_MINIMUM, refused),
    ranking: {
      listPosition: input.listPosition,
      scoreRank: input.scoreRank,
      pairwise: input.strength
        ? {
            strength: input.strength.strength,
            wins: input.strength.wins,
            losses: input.strength.losses,
            ties: input.strength.ties,
            comparisons: input.strength.comparisons,
            refused,
          }
        : null,
      diversity: input.diversity,
      reason: rankReason(input.rank, a, input.scoreRank, input.strength),
    },
    provenance: {
      methods: methods.length ? methods : [a.candidate.method],
      sourceCandidate: a.candidate.derivedFrom ?? null,
      selection: a.selection ?? "priority",
      correction: a.derived,
    },
  });
}

export function listEntry(position: number, status: ListStatus, a: Assessment) {
  return {
    position,
    candidateId: a.candidate.id,
    clipKey: a.candidate.clipKey,
    status,
    evaluation: evaluationOf(status),
    manualReview: status === "provider-refused" || status === "assessment-failed",
    editorialScore: a.scored?.score ?? null,
    tier: a.scored?.tier ?? null,
    ratings: a.scored?.ratings ?? null,
    screeningPriority: a.priority,
    selection: a.selection,
    flags: a.stageA.flags,
    reasons: [
      ...a.stageA.reasons,
      ...(a.screenError ? [a.screenError] : []),
      ...(a.deepError ? [a.deepError] : []),
      ...(a.scored && !a.scored.gate.pass
        ? a.scored.gate.failed.map((f) => `below-gate:${f}`)
        : []),
    ],
    derivedFrom: a.derived?.from ?? null,
  };
}

/**
 * The full order as an ordinary candidate set, so the Phase 2 evaluation
 * tools can compare it with every other method. Clips Stage A removed are
 * left out, like any generator's rejected proposals.
 */
export function toCandidateSet(
  output: RankingOutput,
  assessments: ReadonlyMap<string, Assessment>,
  methodVersion: string,
): CandidateSet {
  const kept = output.list.filter((entry) => entry.status !== "removed");
  return candidateSetSchema.parse({
    method: "ranked",
    methodVersion,
    packSha256: output.packSha256,
    candidates: kept.map((entry, i) => {
      const a = assessments.get(entry.candidateId);
      if (!a) throw new Error(`Missing assessment for ${entry.candidateId}`);
      return {
        ...a.candidate,
        id: `ranked:${a.candidate.clipKey}`,
        method: "ranked",
        methodVersion,
        rank: i + 1,
        score: entry.editorialScore,
        derivedFrom: a.candidate.id,
      };
    }),
    rejected: output.list
      .filter((e) => e.status === "removed")
      .reduce<Record<string, number>>((counts, e) => {
        for (const r of e.reasons) counts[r] = (counts[r] ?? 0) + 1;
        return counts;
      }, {}),
    proposals: output.list.length,
  });
}

const CSV_COLUMNS = [
  "rank",
  "shortlist_rank",
  "alternate_of",
  "segments",
  "duration_s",
  "editorial_score",
  "tier",
  "hook_rating",
  "cliffhanger_rating",
  "clarity_rating",
  "emotion_rating",
  "boundaries_rating",
  "hook",
  "cliffhanger",
  "why_it_works",
  "editor_review",
  "warnings",
  "methods",
  "candidate_id",
] as const;

/**
 * One CSV field. A leading =, +, -, or @ is neutralized because spreadsheets
 * run such cells as formulas, and this text comes from model output.
 */
function csvField(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function whereLabel(segment: Recommendation["segments"][number]): string {
  return `E${String(segment.episode).padStart(3, "0")} ${segment.start} to ${segment.end}`;
}

/** Promos as a spreadsheet: one row each, with every segment in order in one cell. */
export function renderPromosCsv(data: PromoExport): string {
  const rows = data.promos.map(({ promo, shortlistRank, alternateOf }) => {
    const r = promo.criteria;
    return [
      promo.rank,
      shortlistRank,
      alternateOf,
      promo.segments.map(whereLabel).join(" + "),
      (promo.durationMs / 1000).toFixed(2),
      promo.editorialScore,
      promo.tier,
      r.hook.rating,
      r.cliffhanger.rating,
      r.clarity.rating,
      r.emotion.rating,
      r.boundaries.rating,
      promo.hook.explanation,
      promo.cliffhanger.explanation,
      promo.whyItWorks,
      promo.editorReview.join("; "),
      promo.warnings.join("; "),
      promo.provenance.methods.join("; "),
      promo.candidateId,
    ]
      .map(csvField)
      .join(",");
  });
  return [CSV_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Human-readable review summary. Private: it quotes model descriptions of the story. */
export function renderShortlistMarkdown(output: RankingOutput): string {
  const lines = [
    `# Promo shortlist (${output.scope.label})`,
    "",
    `Run ${output.runId}, ${output.createdAt}. Status: **${output.status}**.`,
    `Ranking ${output.versions.ranking} (config ${output.versions.configHash}), rubric ${output.versions.rubric}.`,
    `Models: ${Object.entries(output.versions.models)
      .map(([stage, model]) => `${stage} ${model}`)
      .join(", ")}.`,
    "",
    "The editorial score is the weighted rubric (hook 30%, cliffhanger 25%, clarity 20%, emotion 15%, boundaries 10%) from model judgments checked against the screenplay. It is a ranking aid, not a measured predictor of views. No human has rated these clips yet unless the evaluation report says so.",
    "",
    ...output.notes.map((n) => `- ${n}`),
    "",
  ];
  for (const rec of output.shortlist) {
    const where = rec.segments
      .map((s) => `E${String(s.episode).padStart(3, "0")} ${s.start} to ${s.end}`)
      .join(" + ");
    lines.push(
      `## ${rec.rank}. ${where} (${(rec.durationMs / 1000).toFixed(1)} s)`,
      "",
      `Score ${rec.editorialScore.toFixed(1)} (${rec.tier}). ${CRITERIA.map((c) => `${c.id} ${rec.criteria[c.id].rating}${rec.criteria[c.id].rating < rec.criteria[c.id].raw ? ` (model ${rec.criteria[c.id].raw})` : ""}`).join(", ")}.`,
      "",
      `- **Hook:** ${rec.hook.explanation} Evidence: ${rec.hook.evidence.map((e) => `${e.start} ${e.kind}${e.speaker ? ` ${e.speaker}` : ""}`).join("; ")}.`,
      `- **Cliffhanger:** ${rec.cliffhanger.explanation} (${rec.cliffhanger.tension}). Evidence: ${rec.cliffhanger.evidence.map((e) => `${e.end} ${e.kind}${e.speaker ? ` ${e.speaker}` : ""}`).join("; ")}.`,
      `- **Why it works:** ${rec.whyItWorks}`,
      `- **Cold viewer:** clarity ${rec.standaloneClarity.rating}. Happening (${rec.standaloneClarity.happening.certainty}): ${rec.standaloneClarity.happening.text} Stakes (${rec.standaloneClarity.stakes.certainty}): ${rec.standaloneClarity.stakes.text} Would care: ${rec.standaloneClarity.wouldCare}.${rec.standaloneClarity.missingContext.length ? ` Missing: ${rec.standaloneClarity.missingContext.map((m) => `${m.item}${m.essential ? " (essential)" : ""}`).join("; ")}.` : ""}`,
      `- **Warnings:** ${rec.warnings.join(", ") || "none"}.`,
      ...(rec.editorReview.length ? [`- **Editor check:** ${rec.editorReview.join(", ")}.`] : []),
      `- **Ranking:** ${rec.ranking.reason}`,
      `- **Source:** ${rec.provenance.methods.join(", ")}; selected by ${rec.provenance.selection}${rec.provenance.correction ? `; corrected from ${rec.provenance.correction.from}` : ""}.`,
      "",
    );
  }
  const { refusedClips, refusedComparisons, failedClips } = output.incomplete;
  if (refusedClips.length || refusedComparisons.length || failedClips.length) {
    lines.push("## Needs a manual look", "");
    lines.push(
      "These were not judged. They have no score, sit below every judged clip, and may include strong moments: a provider's filter is not an editor's rejection.",
      "",
    );
    for (const clip of refusedClips) {
      lines.push(`- Refused at the ${clip.stage} stage (${clip.kind}): ${clip.candidateId}.`);
    }
    for (const pair of refusedComparisons) {
      lines.push(`- Comparison refused: ${pair.first} against ${pair.second}.`);
    }
    for (const id of failedClips) lines.push(`- Assessment failed: ${id}.`);
    lines.push("");
  }
  if (output.alternates.length) {
    lines.push("## Alternates set aside as repeats", "");
    for (const alt of output.alternates) {
      lines.push(
        `- List position ${alt.listPosition}: ${alt.candidateId} repeats ${alt.redundantWith} (${alt.basis} ${pct(alt.similarity)}).`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
