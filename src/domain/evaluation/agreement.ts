import type { JudgmentRecord } from "./annotation.ts";
import { CRITERIA, type CriterionId } from "./rubric.ts";

/**
 * Agreement between reviewers who rated the same Part B clips. Computed per
 * pair of reviewers on the clips both rated. Kappa is null when it is not
 * defined (fewer than two shared clips, or no variation at all).
 */

/** Cohen's kappa for two raters on categorical labels. */
export function cohenKappa(pairs: ReadonlyArray<readonly [string, string]>): number | null {
  const n = pairs.length;
  if (n < 2) return null;
  const categories = [...new Set(pairs.flatMap(([a, b]) => [a, b]))];
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const expected = categories.reduce((sum, c) => {
    const pa = pairs.filter(([a]) => a === c).length / n;
    const pb = pairs.filter(([, b]) => b === c).length / n;
    return sum + pa * pb;
  }, 0);
  return expected === 1 ? null : (observed - expected) / (1 - expected);
}

/** Quadratic weighted kappa for two raters on an ordinal 0..levels-1 scale. */
export function weightedKappa(
  pairs: ReadonlyArray<readonly [number, number]>,
  levels = 5,
): number | null {
  const n = pairs.length;
  if (n < 2) return null;
  const observed = Array.from({ length: levels }, () => new Array<number>(levels).fill(0));
  const rows = new Array<number>(levels).fill(0);
  const cols = new Array<number>(levels).fill(0);
  for (const [a, b] of pairs) {
    (observed[a] as number[])[b] = ((observed[a] as number[])[b] ?? 0) + 1 / n;
    rows[a] = (rows[a] ?? 0) + 1 / n;
    cols[b] = (cols[b] ?? 0) + 1 / n;
  }
  let disagreeObserved = 0;
  let disagreeExpected = 0;
  for (let i = 0; i < levels; i++) {
    for (let j = 0; j < levels; j++) {
      const weight = (i - j) ** 2 / (levels - 1) ** 2;
      disagreeObserved += weight * ((observed[i] as number[])[j] ?? 0);
      disagreeExpected += weight * (rows[i] ?? 0) * (cols[j] ?? 0);
    }
  }
  return disagreeExpected === 0 ? null : 1 - disagreeObserved / disagreeExpected;
}

export type PairAgreement = {
  reviewers: [string, string];
  sharedClips: number;
  decisionAgreement: number | null;
  decisionKappa: number | null;
  criteria: Record<
    CriterionId,
    { exact: number | null; withinOne: number | null; weightedKappa: number | null }
  >;
};

export function reviewerAgreement(records: readonly JudgmentRecord[]): {
  reviewers: string[];
  pairs: PairAgreement[];
} {
  const byReviewer = new Map<string, Map<string, JudgmentRecord>>();
  for (const record of records) {
    if (record.source !== "part-b") continue;
    const own = byReviewer.get(record.reviewer) ?? new Map<string, JudgmentRecord>();
    own.set(record.clipKey, record);
    byReviewer.set(record.reviewer, own);
  }
  const reviewers = [...byReviewer.keys()].sort();
  const pairs: PairAgreement[] = [];

  for (let i = 0; i < reviewers.length; i++) {
    for (let j = i + 1; j < reviewers.length; j++) {
      const a = byReviewer.get(reviewers[i] ?? "") ?? new Map<string, JudgmentRecord>();
      const b = byReviewer.get(reviewers[j] ?? "") ?? new Map<string, JudgmentRecord>();
      const shared = [...a.keys()].filter((key) => b.has(key)).sort();
      const both = shared.map(
        (key) => [a.get(key), b.get(key)] as [JudgmentRecord, JudgmentRecord],
      );
      const share = (match: (x: JudgmentRecord, y: JudgmentRecord) => boolean) =>
        both.length ? both.filter(([x, y]) => match(x, y)).length / both.length : null;

      const criteria = Object.fromEntries(
        CRITERIA.map(({ id }) => [
          id,
          {
            exact: share((x, y) => x.judgment.ratings[id] === y.judgment.ratings[id]),
            withinOne: share(
              (x, y) => Math.abs(x.judgment.ratings[id] - y.judgment.ratings[id]) <= 1,
            ),
            weightedKappa: weightedKappa(
              both.map(([x, y]) => [x.judgment.ratings[id], y.judgment.ratings[id]] as const),
            ),
          },
        ]),
      ) as PairAgreement["criteria"];

      pairs.push({
        reviewers: [reviewers[i] ?? "", reviewers[j] ?? ""],
        sharedClips: both.length,
        decisionAgreement: share((x, y) => x.judgment.decision === y.judgment.decision),
        decisionKappa: cohenKappa(
          both.map(([x, y]) => [x.judgment.decision, y.judgment.decision] as const),
        ),
        criteria,
      });
    }
  }
  return { reviewers, pairs };
}
