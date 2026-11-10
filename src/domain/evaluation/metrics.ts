import type { JudgmentRecord } from "./annotation.ts";
import { intervalIoU, parseClipKey, type Candidate, type Interval } from "./candidate.ts";
import { relevanceGain } from "./rubric.ts";
import type { SetCheck } from "./structural-checks.ts";

/**
 * Ranking metrics against human judgments. Definitions are in
 * docs/evaluation.md. Key rules:
 *
 * - A pick no human rated is "unjudged". It is skipped, never counted as bad.
 *   Precision and nDCG use the condensed list: the first K judged picks.
 *   judgedAtK says how much of the real top K was rated.
 * - A pick that overlaps a higher-ranked pick (IoU >= duplicateIoU) is
 *   redundant and earns nothing. It counts as judged only when the pick it
 *   repeats was judged.
 * - Recall is computed only for episodes a reviewer marked complete in Part A.
 * - Results are averaged per episode, so long episodes do not dominate.
 */

export type MetricOptions = {
  k: number;
  matchIoU: number;
  duplicateIoU: number;
  /** Cut-off for the show-level list metrics. */
  listK?: number;
};
export const DEFAULT_METRIC_OPTIONS: MetricOptions = {
  k: 3,
  matchIoU: 0.5,
  duplicateIoU: 0.5,
  listK: 10,
};

type Ranked = Pick<Candidate, "id" | "rank" | "clipKey" | "segments">;
type Verdict = { relevant: boolean; gain: number; reviewers: number };

export type ClipLabel = {
  candidateId: string;
  rank: number;
  status: "relevant" | "not-relevant" | "redundant" | "unjudged";
  gain: number;
  source: "part-b" | "part-a" | "duplicate" | null;
  /** Id of the higher-ranked pick this one repeats, if any. */
  duplicateOf: string | null;
};

/**
 * One verdict per Part B clip. Kept when a strict majority of reviewers kept
 * it (a tie is not kept). Gain is the lower median of the reviewers' gains.
 */
export function consolidate(records: readonly JudgmentRecord[]): Map<string, Verdict> {
  const byClip = new Map<string, JudgmentRecord[]>();
  for (const record of records) {
    if (record.source !== "part-b") continue;
    byClip.set(record.clipKey, [...(byClip.get(record.clipKey) ?? []), record]);
  }
  const verdicts = new Map<string, Verdict>();
  for (const [key, group] of byClip) {
    const keeps = group.filter((r) => r.judgment.decision === "keep").length;
    const gains = group.map((r) => relevanceGain(r.judgment)).sort((a, b) => a - b);
    verdicts.set(key, {
      relevant: keeps * 2 > group.length,
      gain: gains[Math.floor((gains.length - 1) / 2)] ?? 0,
      reviewers: group.length,
    });
  }
  return verdicts;
}

/** One-to-one matching in rank order: each pick takes the best free reference with IoU >= threshold. */
export function matchGreedy(
  picks: readonly Pick<Ranked, "segments">[],
  references: readonly Interval[][],
  threshold: number,
): Map<number, number> {
  const used = new Set<number>();
  const matches = new Map<number, number>();
  picks.forEach((pick, i) => {
    let best = -1;
    let bestIoU = -1;
    references.forEach((reference, j) => {
      if (used.has(j)) return;
      const iou = intervalIoU(pick.segments, reference);
      if (iou >= threshold && iou > bestIoU) {
        best = j;
        bestIoU = iou;
      }
    });
    if (best >= 0) {
      used.add(best);
      matches.set(i, best);
    }
  });
  return matches;
}

function byRank(a: Ranked, b: Ranked): number {
  return a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function labelRanking(
  picks: readonly Ranked[],
  references: { verdicts: Map<string, Verdict>; partA: readonly JudgmentRecord[] },
  options: MetricOptions,
): ClipLabel[] {
  const sorted = [...picks].sort(byRank);
  const coveredBy = new Map<string, Ranked>();
  const distinct: Ranked[] = [];
  for (const pick of sorted) {
    const earlier = distinct.find(
      (d) => intervalIoU(d.segments, pick.segments) >= options.duplicateIoU,
    );
    if (earlier) coveredBy.set(pick.id, earlier);
    else distinct.push(pick);
  }

  const matches = matchGreedy(
    distinct,
    references.partA.map((r) => r.segments),
    options.matchIoU,
  );
  const labels = new Map<string, ClipLabel>();
  distinct.forEach((pick, i) => {
    const verdict = references.verdicts.get(pick.clipKey);
    const match = matches.get(i);
    const reference = match === undefined ? undefined : references.partA[match];
    const base = { candidateId: pick.id, rank: pick.rank, duplicateOf: null };
    if (verdict) {
      labels.set(pick.id, {
        ...base,
        status: verdict.relevant ? "relevant" : "not-relevant",
        gain: verdict.gain,
        source: "part-b",
      });
    } else if (reference) {
      const keep = reference.judgment.decision === "keep";
      labels.set(pick.id, {
        ...base,
        status: keep ? "relevant" : "not-relevant",
        gain: relevanceGain(reference.judgment),
        source: "part-a",
      });
    } else {
      labels.set(pick.id, { ...base, status: "unjudged", gain: 0, source: null });
    }
  });

  return sorted.map((pick) => {
    const earlier = coveredBy.get(pick.id);
    if (!earlier) return labels.get(pick.id) as ClipLabel;
    const judged = labels.get(earlier.id)?.status !== "unjudged";
    return {
      candidateId: pick.id,
      rank: pick.rank,
      status: judged ? "redundant" : "unjudged",
      gain: 0,
      source: judged ? "duplicate" : null,
      duplicateOf: earlier.id,
    };
  });
}

export function dcg(gains: readonly number[]): number {
  return gains.reduce((sum, gain, i) => sum + gain / Math.log2(i + 2), 0);
}

export type EpisodeResult = {
  episode: number;
  picks: number;
  labels: ClipLabel[];
  judgedAtK: number | null;
  precisionAtK: number | null;
  ndcgAtK: number | null;
  recallAtK: number | null;
  boundaryErrors: Array<{ startMs: number; endMs: number }>;
  unavailable: string[];
};

export function evaluateEpisode(
  episode: number,
  picks: readonly Ranked[],
  references: {
    verdicts: Map<string, Verdict>;
    partA: readonly JudgmentRecord[];
    completeReviewers: readonly string[];
  },
  options: MetricOptions = DEFAULT_METRIC_OPTIONS,
): EpisodeResult {
  const unavailable: string[] = [];
  const sorted = [...picks].sort(byRank);
  const labels = labelRanking(sorted, references, options);
  const k = options.k;

  const window = labels.slice(0, k);
  const judgedAtK = window.length
    ? window.filter((l) => l.status !== "unjudged").length / window.length
    : null;

  const top = labels.filter((l) => l.status !== "unjudged").slice(0, k);
  const precisionAtK = top.length
    ? top.filter((l) => l.status === "relevant").length / top.length
    : null;
  if (!top.length) unavailable.push("no judged picks");

  const pool = idealPool(episode, references, options.duplicateIoU);
  const idcg = dcg(pool.slice(0, k));
  let ndcgAtK: number | null = null;
  if (idcg === 0) unavailable.push("no positive references for nDCG");
  else if (top.length) ndcgAtK = dcg(top.map((l) => l.gain)) / idcg;

  const isDistinct = (_: Ranked, i: number) => labels[i]?.duplicateOf === null;
  const distinct = sorted.filter(isDistinct);
  const distinctTopK = sorted.slice(0, k).filter(isDistinct);
  const recalls: number[] = [];
  const boundaryErrors: EpisodeResult["boundaryErrors"] = [];
  for (const reviewer of new Set(references.partA.map((r) => r.reviewer))) {
    const kept = references.partA.filter(
      (r) => r.reviewer === reviewer && r.judgment.decision === "keep",
    );
    if (!kept.length) continue;
    const refs = kept.map((r) => r.segments);

    if (references.completeReviewers.includes(reviewer)) {
      recalls.push(matchGreedy(distinctTopK, refs, options.matchIoU).size / refs.length);
    }
    for (const [i, j] of matchGreedy(distinct, refs, options.matchIoU)) {
      const pick = distinct[i];
      const ref = refs[j];
      if (pick?.segments.length === 1 && ref?.length === 1 && pick.segments[0] && ref[0]) {
        boundaryErrors.push({
          startMs: Math.abs(pick.segments[0].startMs - ref[0].startMs),
          endMs: Math.abs(pick.segments[0].endMs - ref[0].endMs),
        });
      }
    }
  }
  if (!recalls.length) unavailable.push("no complete Part A reference for recall");

  return {
    episode,
    picks: sorted.length,
    labels,
    judgedAtK,
    precisionAtK,
    ndcgAtK,
    recallAtK: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
    boundaryErrors,
    unavailable,
  };
}

/** Best possible gains for an episode: every judged clip, with near-duplicates merged. */
function idealPool(
  episode: number,
  references: { verdicts: Map<string, Verdict>; partA: readonly JudgmentRecord[] },
  duplicateIoU: number,
): number[] {
  const items: Array<{ segments: Interval[]; gain: number }> = [];
  for (const [key, verdict] of references.verdicts) {
    const segments = parseClipKey(key);
    if (segments.some((s) => s.episode === episode)) items.push({ segments, gain: verdict.gain });
  }
  for (const record of references.partA)
    items.push({ segments: record.segments, gain: relevanceGain(record.judgment) });
  items.sort((a, b) => b.gain - a.gain);
  const kept: typeof items = [];
  for (const item of items) {
    if (!kept.some((k) => intervalIoU(k.segments, item.segments) >= duplicateIoU)) kept.push(item);
  }
  return kept.map((item) => item.gain).filter((gain) => gain > 0);
}

const mean = (values: readonly number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

const median = (values: readonly number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

export type MethodResult = {
  method: string;
  episodes: EpisodeResult[];
  /** Mean over episodes where the metric exists, with how many episodes that was. */
  macro: Record<
    "judgedAtK" | "precisionAtK" | "ndcgAtK" | "recallAtK",
    { value: number | null; episodes: number }
  >;
  boundary: {
    pairs: number;
    medianStartMs: number | null;
    medianEndMs: number | null;
    meanStartMs: number | null;
    meanEndMs: number | null;
  };
};

/** Scores one method on the given episodes. Each episode counts once. */
export function evaluateMethod(
  method: string,
  candidates: readonly Ranked[],
  episodes: readonly number[],
  references: {
    records: readonly JudgmentRecord[];
    completeEpisodes: ReadonlyArray<{ reviewer: string; episode: number }>;
  },
  options: MetricOptions = DEFAULT_METRIC_OPTIONS,
): MethodResult {
  const verdicts = consolidate(references.records);
  const results = [...episodes]
    .sort((a, b) => a - b)
    .map((episode) =>
      evaluateEpisode(
        episode,
        candidates.filter((c) => c.segments[0]?.episode === episode),
        {
          verdicts,
          partA: references.records.filter(
            (r) => r.source === "part-a" && r.segments.some((s) => s.episode === episode),
          ),
          completeReviewers: references.completeEpisodes
            .filter((c) => c.episode === episode)
            .map((c) => c.reviewer),
        },
        options,
      ),
    );

  const macro = (key: "judgedAtK" | "precisionAtK" | "ndcgAtK" | "recallAtK") => {
    const values = results.map((r) => r[key]).filter((v): v is number => v !== null);
    return { value: mean(values), episodes: values.length };
  };
  const errors = results.flatMap((r) => r.boundaryErrors);
  return {
    method,
    episodes: results,
    macro: {
      judgedAtK: macro("judgedAtK"),
      precisionAtK: macro("precisionAtK"),
      ndcgAtK: macro("ndcgAtK"),
      recallAtK: macro("recallAtK"),
    },
    boundary: {
      pairs: errors.length,
      medianStartMs: median(errors.map((e) => e.startMs)),
      medianEndMs: median(errors.map((e) => e.endMs)),
      meanStartMs: mean(errors.map((e) => e.startMs)),
      meanEndMs: mean(errors.map((e) => e.endMs)),
    },
  };
}

export type StructuralSummary = {
  candidates: number;
  valid: number;
  validityRate: number | null;
  episodes: number;
  episodesWithValid: number;
  episodeCoverage: number | null;
  duplicates: number;
  duplicateRate: number | null;
  issueCounts: SetCheck["counts"];
};

/** Label-free quality of a candidate set on the given episodes. */
export function structuralSummary(
  candidates: readonly Candidate[],
  check: SetCheck,
  episodes: readonly number[],
): StructuralSummary {
  const inScope = candidates.filter((c) => episodes.includes(c.segments[0]?.episode ?? 0));
  const isValid = (c: Candidate) =>
    !(check.byCandidate.get(c.id) ?? []).some((i) => i.severity === "error");
  const isDuplicate = (c: Candidate) =>
    (check.byCandidate.get(c.id) ?? []).some(
      (i) => i.code === "duplicate-interval" || i.code === "near-duplicate",
    );
  const valid = inScope.filter(isValid);
  const covered = new Set(valid.map((c) => c.segments[0]?.episode));
  const counts: SetCheck["counts"] = {};
  for (const candidate of inScope) {
    for (const item of check.byCandidate.get(candidate.id) ?? [])
      counts[item.code] = (counts[item.code] ?? 0) + 1;
  }
  const rate = (n: number, d: number) => (d ? n / d : null);
  return {
    candidates: inScope.length,
    valid: valid.length,
    validityRate: rate(valid.length, inScope.length),
    episodes: episodes.length,
    episodesWithValid: episodes.filter((e) => covered.has(e)).length,
    episodeCoverage: rate(episodes.filter((e) => covered.has(e)).length, episodes.length),
    duplicates: inScope.filter(isDuplicate).length,
    duplicateRate: rate(inScope.filter(isDuplicate).length, inScope.length),
    issueCounts: counts,
  };
}

export type ListResult = {
  k: number;
  /** Candidates of the method in the chosen episodes. */
  picks: number;
  labels: ClipLabel[];
  /** Share of the real top K that a human judged (redundant picks of a judged clip count). */
  judgedAtK: number | null;
  /** Unjudged picks in the real top K. They are skipped, never counted as bad. */
  unjudgedInTopK: number;
  /** Judged-only: precision over the first K judged distinct picks. */
  precisionAtK: number | null;
  /** Judged-only: nDCG over the first K judged picks against every judged clip in scope. */
  ndcgAtK: number | null;
  unavailable: string[];
};

/**
 * Show-level metrics: the method's whole ranking over the chosen episodes,
 * read as one list, the way an editor would read a shortlist. Same rules as
 * the per-episode metrics: unjudged picks are skipped (judged-only), repeats
 * of a higher pick earn nothing, and Part B verdicts win over Part A matches.
 * Recall is not computed here; it needs complete Part A references and is
 * reported per episode.
 */
export function evaluateList(
  candidates: readonly Ranked[],
  episodes: readonly number[],
  references: { records: readonly JudgmentRecord[] },
  options: MetricOptions = DEFAULT_METRIC_OPTIONS,
): ListResult {
  const k = options.listK ?? 10;
  const inScope = (segments: readonly Interval[]) =>
    segments.some((s) => episodes.includes(s.episode));
  const picks = candidates
    .filter((c) => episodes.includes(c.segments[0]?.episode ?? 0))
    .sort(byRank);
  const verdicts = consolidate(references.records.filter((r) => inScope(r.segments)));
  const partA = references.records.filter((r) => r.source === "part-a" && inScope(r.segments));
  const labels = labelRanking(picks, { verdicts, partA }, options);
  const unavailable: string[] = [];

  const window = labels.slice(0, k);
  const judgedAtK = window.length
    ? window.filter((l) => l.status !== "unjudged").length / window.length
    : null;
  const top = labels.filter((l) => l.status !== "unjudged").slice(0, k);
  const precisionAtK = top.length
    ? top.filter((l) => l.status === "relevant").length / top.length
    : null;
  if (!top.length) unavailable.push("no judged picks");

  const items: Array<{ segments: Interval[]; gain: number }> = [];
  for (const [key, verdict] of verdicts)
    items.push({ segments: parseClipKey(key), gain: verdict.gain });
  for (const record of partA)
    items.push({ segments: record.segments, gain: relevanceGain(record.judgment) });
  items.sort((a, b) => b.gain - a.gain);
  const kept: typeof items = [];
  for (const item of items) {
    if (!kept.some((x) => intervalIoU(x.segments, item.segments) >= options.duplicateIoU))
      kept.push(item);
  }
  const idcg = dcg(
    kept
      .map((x) => x.gain)
      .filter((g) => g > 0)
      .slice(0, k),
  );
  let ndcgAtK: number | null = null;
  if (idcg === 0) unavailable.push("no positive references for nDCG");
  else if (top.length) ndcgAtK = dcg(top.map((l) => l.gain)) / idcg;

  return {
    k,
    picks: picks.length,
    labels: labels.slice(0, k + 5),
    judgedAtK,
    unjudgedInTopK: window.filter((l) => l.status === "unjudged").length,
    precisionAtK,
    ndcgAtK,
    unavailable,
  };
}
