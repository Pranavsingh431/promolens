import type { Interval } from "@/domain/evaluation/candidate";
import { parseClipKey } from "@/domain/evaluation/candidate";
import type { Recommendation } from "@/domain/ranking/output";

import type { AnalysisResults } from "./service";
import { describeReview, describeWarning, type Note } from "./wording";

/**
 * Turns the rank-3 output into what the results screen lists.
 *
 * Status comes straight from the contract:
 * - Recommended: on the shortlist.
 * - Alternative: passed every check but is not on the shortlist. `repeatOf` is
 *   set when it was set aside because it retells a recommendation.
 * - Needs review: `editorReview` is not empty. A flag, not a list position.
 * - Incomplete: `manualReview` is true on the list entry, so no judgment exists.
 */

export type PromoRow = {
  id: string;
  promo: Recommendation;
  status: "recommended" | "alternative";
  /** The rank shown to an editor: shortlist rank, or overall position for an alternative. */
  displayRank: number;
  repeatOf: { id: string; rank: number | null } | null;
  review: Note[];
  warnings: Note[];
};

export type UnevaluatedRow = {
  id: string;
  segments: Interval[];
  durationMs: number;
  reason: "provider-refused" | "failed";
};

export type ResultsModel = {
  recommended: PromoRow[];
  alternatives: PromoRow[];
  unevaluated: UnevaluatedRow[];
  partial: boolean;
  /** Clips screening set aside before detailed evaluation. Not a failure. */
  notAssessed: number;
};

const SEVERITY_ORDER = { important: 0, content: 1, minor: 2 } as const;

/** Things an editor should act on before posting: review flags first, then serious warnings. */
export function attentionNotes(row: PromoRow): Note[] {
  return [...row.review, ...row.warnings.filter((w) => w.severity !== "minor")];
}

function row(
  promo: Recommendation,
  status: PromoRow["status"],
  displayRank: number,
  repeatOf: PromoRow["repeatOf"],
): PromoRow {
  return {
    id: promo.candidateId,
    promo,
    status,
    displayRank,
    repeatOf,
    review: promo.editorReview.map(describeReview),
    warnings: promo.warnings
      .map(describeWarning)
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
  };
}

export function buildResultsModel({ ranking, promos }: AnalysisResults): ResultsModel {
  const shortlistRank = new Map(ranking.shortlist.map((r) => [r.candidateId, r.rank]));
  const recommended = ranking.shortlist.map((promo) => row(promo, "recommended", promo.rank, null));
  const alternatives = promos.promos
    .filter((entry) => !shortlistRank.has(entry.promo.candidateId))
    .map(({ promo, alternateOf }) =>
      row(
        promo,
        "alternative",
        promo.rank,
        alternateOf ? { id: alternateOf, rank: shortlistRank.get(alternateOf) ?? null } : null,
      ),
    );
  const unevaluated: UnevaluatedRow[] = ranking.list
    .filter((entry) => entry.manualReview)
    .map((entry) => {
      const segments = parseClipKey(entry.clipKey);
      return {
        id: entry.candidateId,
        segments,
        durationMs: segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0),
        reason: entry.evaluation === "provider-refused" ? "provider-refused" : "failed",
      };
    });
  return {
    recommended,
    alternatives,
    unevaluated,
    partial: ranking.status === "partial",
    notAssessed: ranking.list.filter((entry) => entry.evaluation === "not-run").length,
  };
}
