import type { Timeline } from "../screenplay/timeline.ts";
import { reviewerAgreement } from "./agreement.ts";
import { collectJudgments, type AnnotationFile } from "./annotation.ts";
import type { CandidateSet } from "./candidate.ts";
import {
  consolidate,
  evaluateList,
  evaluateMethod,
  structuralSummary,
  type ListResult,
  type MethodResult,
  type MetricOptions,
  type StructuralSummary,
} from "./metrics.ts";
import type { ReviewKey } from "./review.ts";
import { RUBRIC_VERSION } from "./rubric.ts";
import { episodesInSplit, type EvaluationSample, type Split } from "./sample.ts";
import { checkCandidateSet } from "./structural-checks.ts";

/** Human ratings of the final recommendations against lower-ranked clips from their episodes. */
export type ShortlistCheck = Array<{
  role: "shortlist" | "shortlist-control";
  items: number;
  rated: number;
  kept: number;
  meanGain: number | null;
}>;

/** Only real Part B ratings count. A clip nobody rated is reported as unrated, never as rejected. */
export function shortlistCheck(
  records: Parameters<typeof consolidate>[0],
  key: ReviewKey,
): ShortlistCheck | null {
  const verdicts = consolidate(records);
  const rows: ShortlistCheck = (["shortlist", "shortlist-control"] as const).map((role) => {
    const clips = key.entries.filter((e) => e.candidates.some((c) => c.role === role));
    const rated = clips.flatMap((e) => verdicts.get(e.clipKey) ?? []);
    return {
      role,
      items: clips.length,
      rated: rated.length,
      kept: rated.filter((v) => v.relevant).length,
      meanGain: rated.length ? rated.reduce((sum, v) => sum + v.gain, 0) / rated.length : null,
    };
  });
  return rows.some((row) => row.items > 0) ? rows : null;
}

export type EvaluationReport = {
  sampleVersion: string;
  rubricVersion: string;
  split: Split | "all";
  episodes: number[];
  options: MetricOptions;
  annotations: {
    reviewers: string[];
    partAMoments: number;
    partAEpisodesComplete: number;
    partBReviews: number;
    status: "awaiting-review" | "partial" | "available";
  };
  methods: Array<{
    method: string;
    methodVersion: string;
    structural: StructuralSummary;
    editorial: MethodResult | null;
    /** Show-level list metrics over the split, judged-only. Null without human judgments. */
    list: ListResult | null;
  }>;
  agreement: ReturnType<typeof reviewerAgreement> | null;
  /** Null when the review round has no shortlist items. */
  shortlist: ShortlistCheck | null;
  notes: string[];
};

/**
 * Builds the comparison for one split. Structural metrics always run.
 * Editorial metrics run only on real human judgments for these episodes;
 * with none, they are reported as unavailable rather than as zero.
 */
export function buildEvaluationReport(input: {
  sample: EvaluationSample;
  split: Split | "all";
  sets: readonly CandidateSet[];
  timeline: Timeline;
  files: readonly AnnotationFile[];
  options: MetricOptions;
  reviewKey?: ReviewKey;
}): EvaluationReport {
  const episodes = episodesInSplit(input.sample, input.split);
  const inScope = (episode: number) => episodes.includes(episode);
  const { records, completeEpisodes } = collectJudgments(input.files);
  const scopedRecords = records.filter((r) => r.segments.some((s) => inScope(s.episode)));
  const scopedComplete = completeEpisodes.filter((c) => inScope(c.episode));

  const partAMoments = scopedRecords.filter((r) => r.source === "part-a").length;
  const partBReviews = scopedRecords.filter((r) => r.source === "part-b").length;
  const status =
    scopedRecords.length === 0
      ? "awaiting-review"
      : scopedComplete.length === 0
        ? "partial"
        : "available";

  const notes: string[] = [];
  if (status === "awaiting-review") {
    notes.push(
      "No human judgments exist for these episodes yet. Editorial metrics are unavailable. Structural metrics are shown.",
    );
  } else if (status === "partial") {
    notes.push("No episode has a complete Part A review, so recall is unavailable.");
  }
  if (input.split === "held-out") {
    notes.push("Held-out results are for final checks only. Do not tune methods on them.");
  }

  const methods = input.sets.map((set) => ({
    method: set.method,
    methodVersion: set.methodVersion,
    structural: structuralSummary(set.candidates, checkCandidateSet(set, input.timeline), episodes),
    editorial:
      scopedRecords.length === 0
        ? null
        : evaluateMethod(
            set.method,
            set.candidates,
            episodes,
            { records: scopedRecords, completeEpisodes: scopedComplete },
            input.options,
          ),
    list:
      scopedRecords.length === 0
        ? null
        : evaluateList(set.candidates, episodes, { records: scopedRecords }, input.options),
  }));

  const agreement = reviewerAgreement(scopedRecords);
  return {
    sampleVersion: input.sample.version,
    rubricVersion: RUBRIC_VERSION,
    split: input.split,
    episodes,
    options: input.options,
    annotations: {
      reviewers: [...new Set(input.files.map((f) => f.reviewer))].sort(),
      partAMoments,
      partAEpisodesComplete: scopedComplete.length,
      partBReviews,
      status,
    },
    methods,
    agreement: agreement.pairs.some((p) => p.sharedClips > 0) ? agreement : null,
    shortlist: input.reviewKey ? shortlistCheck(records, input.reviewKey) : null,
    notes,
  };
}

const pct = (value: number | null) =>
  value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
const num = (value: number | null) => (value === null ? "unavailable" : value.toFixed(3));
const secs = (ms: number | null) => (ms === null ? "unavailable" : `${(ms / 1000).toFixed(2)} s`);

/** Plain Markdown summary of a report. Contains ids and numbers only, never script text. */
export function renderReportMarkdown(report: EvaluationReport): string {
  const k = report.options.k;
  const lines = [
    `# Baseline comparison (${report.split})`,
    "",
    `Sample ${report.sampleVersion}, rubric ${report.rubricVersion}, episodes ${report.episodes.join(", ")}.`,
    `K = ${k}. Match IoU ${report.options.matchIoU}. Duplicate IoU ${report.options.duplicateIoU}.`,
    "",
    `Human annotation status: **${report.annotations.status}**. Reviewers: ${report.annotations.reviewers.join(", ") || "none"}. ` +
      `Part A moments ${report.annotations.partAMoments} (complete episodes ${report.annotations.partAEpisodesComplete}), Part B ratings ${report.annotations.partBReviews}.`,
    "",
    ...report.notes.map((note) => `- ${note}`),
    "",
    "## Structural metrics (no labels needed)",
    "",
    "| Method | Candidates | Valid | Episode coverage | Duplicates | Mid-line starts | Mid-line ends |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.methods.map(
      (m) =>
        `| ${m.method} (${m.methodVersion}) | ${m.structural.candidates} | ${pct(m.structural.validityRate)} | ` +
        `${m.structural.episodesWithValid}/${m.structural.episodes} | ${pct(m.structural.duplicateRate)} | ` +
        `${m.structural.issueCounts["starts-mid-dialogue"] ?? 0} | ${m.structural.issueCounts["ends-mid-dialogue"] ?? 0} |`,
    ),
    "",
    "## Editorial metrics (human judgments)",
    "",
  ];

  if (report.methods.every((m) => m.editorial === null)) {
    lines.push("Unavailable: no human judgments yet.", "");
  } else {
    lines.push(
      `| Method | Judged@${k} | Precision@${k} | nDCG@${k} | Recall@${k} | Boundary error (median start / end) |`,
      "| --- | --- | --- | --- | --- | --- |",
      ...report.methods.map((m) => {
        const e = m.editorial;
        if (!e)
          return `| ${m.method} | unavailable | unavailable | unavailable | unavailable | unavailable |`;
        const cell = (
          metric: { value: number | null; episodes: number },
          format: (v: number | null) => string,
        ) => `${format(metric.value)} (${metric.episodes} ep)`;
        return (
          `| ${m.method} | ${cell(e.macro.judgedAtK, pct)} | ${cell(e.macro.precisionAtK, pct)} | ` +
          `${cell(e.macro.ndcgAtK, num)} | ${cell(e.macro.recallAtK, pct)} | ` +
          `${secs(e.boundary.medianStartMs)} / ${secs(e.boundary.medianEndMs)} (${e.boundary.pairs} pairs) |`
        );
      }),
      "",
      `### Show-level list (top ${report.options.listK ?? 10} over the split, judged-only)`,
      "",
      "Precision and nDCG count only picks a human judged; unjudged picks are skipped, not counted as bad. Judged@K says how much of the real top K was judged. With few labels these numbers are fragile.",
      "",
      `| Method | Picks | Judged@K | Unjudged in top K | Precision@K (judged-only) | nDCG@K (judged-only) |`,
      "| --- | --- | --- | --- | --- | --- |",
      ...report.methods.map((m) => {
        const l = m.list;
        if (!l)
          return `| ${m.method} | unavailable | unavailable | unavailable | unavailable | unavailable |`;
        return `| ${m.method} | ${l.picks} | ${pct(l.judgedAtK)} | ${l.unjudgedInTopK} | ${pct(l.precisionAtK)} | ${num(l.ndcgAtK)} |`;
      }),
      "",
      "### Per episode",
      "",
      "| Method | Episode | Picks | Judged@K | P@K | nDCG@K | R@K | Labels in rank order |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...report.methods.flatMap((m) =>
        (m.editorial?.episodes ?? []).map(
          (e) =>
            `| ${m.method} | ${e.episode} | ${e.picks} | ${pct(e.judgedAtK)} | ${pct(e.precisionAtK)} | ` +
            `${num(e.ndcgAtK)} | ${pct(e.recallAtK)} | ${e.labels
              .slice(0, k + 2)
              .map((l) => l.status)
              .join(", ")} |`,
        ),
      ),
      "",
    );
  }

  lines.push("## Reviewer agreement", "");
  if (!report.agreement) {
    lines.push("Unavailable: fewer than two reviewers rated the same clips.", "");
  } else {
    lines.push(
      "| Pair | Shared clips | Keep/reject agreement | Kappa | Clarity weighted kappa |",
      "| --- | --- | --- | --- | --- |",
      ...report.agreement.pairs.map(
        (p) =>
          `| ${p.reviewers.join(" / ")} | ${p.sharedClips} | ${pct(p.decisionAgreement)} | ${num(p.decisionKappa)} | ${num(p.criteria.clarity.weightedKappa)} |`,
      ),
      "",
    );
  }
  if (report.shortlist) {
    lines.push(
      "",
      "## Final recommendations against lower-ranked clips",
      "",
      "Human Part B ratings only. A clip nobody rated is unrated, not rejected.",
      "",
      "| Group | Clips | Rated | Kept | Mean gain |",
      "| --- | --- | --- | --- | --- |",
      ...report.shortlist.map(
        (row) =>
          `| ${row.role === "shortlist" ? "Final recommendations" : "Lower-ranked clips from the same episodes"} | ${row.items} | ${row.rated} | ${row.rated ? row.kept : "unavailable"} | ${num(row.meanGain)} |`,
      ),
    );
  }
  return lines.join("\n");
}
