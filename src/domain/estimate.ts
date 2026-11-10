import { MAX_FINALISTS } from "./ranking/plan.ts";

/**
 * Time and cost estimates for an analysis, before it starts and while it runs.
 *
 * The numbers that drive them are measured, not guessed: per-call latency and
 * cost per stage come from recorded model calls (see
 * src/server/analysis/calibration.ts), and the work counts follow the rank-4
 * plan. What cannot be known in advance (how many candidates discovery finds,
 * how many evaluated clips pass the gates) is given as a range, so every
 * estimate is a range too. A stage with no measurements makes the estimate
 * unavailable rather than invented.
 */

export const ESTIMATE_STAGES = [
  "discovery",
  "screen",
  "cold-viewer",
  "editorial",
  "pairwise",
] as const;
export type EstimateStage = (typeof ESTIMATE_STAGES)[number];

export type StageProfile = {
  p50Ms: number;
  p95Ms: number;
  /** Per call: the measured billed share of the token price, and the full token price plus a margin. */
  costLowUsd: number;
  costHighUsd: number;
  /** Share of calls that needed another attempt. */
  retryShare: number;
};

export type WorkProfile = {
  concurrency: number;
  budgetUsd: number;
  maxRequests: number;
  discoveryBatch: number;
  stepBudgetMs: number;
  /** Null when the configured model for that stage has never been measured. */
  stages: Record<EstimateStage, StageProfile | null>;
};

/** Planned work. `detailed` counts clips; each needs a cold-viewer and an editorial judgment. */
export type Work = { discovery: number; screen: number; detailed: number; comparisons: number };

export type Range = { low: number; high: number };

export type AnalysisEstimate = {
  work: { low: Work; high: Work };
  requests: Range;
  timeMs: Range | null;
  costUsd: Range | null;
  /** "yes" when even the low cost is over the job budget, "maybe" when only the high one is. */
  overBudget: "no" | "maybe" | "yes";
};

/**
 * Candidates grow with how much script there is, with a floor per episode
 * because the uniform baseline proposes windows in every episode. The supplied
 * pack gave 278 candidates from 516.6 KB of text (0.54 per KB) in 50 episodes;
 * a made-up 4-episode show of 10 KB gave about 12.
 */
const CANDIDATES_PER_KB: Range = { low: 0.45, high: 0.65 };
const CANDIDATES_PER_EPISODE_FLOOR: Range = { low: 2.5, high: 3.5 };
/** With no text size, the per-episode range has to cover long episodes too. */
const CANDIDATES_PER_EPISODE_UNSIZED: Range = { low: 2.5, high: 6.5 };

function candidateRange(episodes: number, textKb: number | undefined): Range {
  if (textKb === undefined) {
    return {
      low: episodes * CANDIDATES_PER_EPISODE_UNSIZED.low,
      high: episodes * CANDIDATES_PER_EPISODE_UNSIZED.high,
    };
  }
  return {
    low: Math.max(episodes * CANDIDATES_PER_EPISODE_FLOOR.low, textKb * CANDIDATES_PER_KB.low),
    high: Math.max(episodes * CANDIDATES_PER_EPISODE_FLOOR.high, textKb * CANDIDATES_PER_KB.high),
  };
}
/**
 * Distinct clips that pass the gates, per clip evaluated in detail. 95 of 118
 * evaluated clips passed on the supplied pack (0.81); repeats of the same story
 * beat lower the distinct share by an amount one show cannot pin down.
 */
const PASS_SHARE: Range = { low: 0.5, high: 0.8 };
/** Share of evaluated clips with a correction judged: 8 for 30 considered on the supplied pack. */
const CORRECTION_SHARE = 0.27;
/** Each finalist meets its 3 nearest finalists in both orders: 96 judgments for 16 finalists. */
const COMPARISONS_PER_FINALIST = 6;
/** Parsing, storage, and workflow hand-offs. */
const OVERHEAD_MS: Range = { low: 10_000, high: 30_000 };
const SLICE_OVERHEAD_MS: Range = { low: 2_000, high: 5_000 };

/** The rank-4 workload for one scenario. Mirrors planRankingConfig and the top-up rule. */
export function plannedWork(
  requested: number,
  episodes: number,
  candidates: number,
  passShare: number,
): Work {
  const n = requested;
  const shortlist = Math.max(24, 8 * Math.min(n, 10));
  const explore = Math.round(shortlist * 0.15);
  const floors = n >= 10 ? Math.round(0.4 * episodes * Math.max(0, 1 - shortlist / candidates)) : 0;
  const initial = Math.min(candidates, shortlist + explore + floors + 2);
  const assessed = Math.min(candidates, Math.max(initial, Math.ceil(n / passShare)));
  const corrections = Math.min(
    Math.max(4, Math.ceil(1.2 * n)),
    Math.round(CORRECTION_SHARE * Math.min(assessed, 3 * n)),
  );
  const finalists = Math.min(
    Math.min(MAX_FINALISTS, Math.max(8, n + 6)),
    Math.floor(assessed * passShare),
  );
  return {
    discovery: 2 * episodes,
    screen: candidates,
    detailed: assessed + corrections,
    comparisons: COMPARISONS_PER_FINALIST * finalists,
  };
}

const calls = (w: Work) => w.discovery + w.screen + 2 * w.detailed + w.comparisons;

/** Time for one stage's calls through a shared pool of `concurrency` slots, plus the last wave. */
function stageMs(count: number, stage: StageProfile, concurrency: number, side: "low" | "high") {
  if (count <= 0) return 0;
  if (side === "low") return (count * stage.p50Ms) / concurrency + stage.p50Ms;
  const typical = ((stage.p50Ms + stage.p95Ms) / 2) * (1 + stage.retryShare);
  return (count * typical) / concurrency + stage.p95Ms;
}

/** Wall time for some amount of remaining work, or null without measurements. */
export function workTime(profile: WorkProfile, work: Work, side: "low" | "high"): number | null {
  const s = profile.stages;
  if (!s.discovery || !s.screen || !s["cold-viewer"] || !s.editorial || !s.pairwise) return null;
  const c = Math.max(1, profile.concurrency);
  const detailed: StageProfile = {
    p50Ms: (s["cold-viewer"].p50Ms + s.editorial.p50Ms) / 2,
    p95Ms: Math.max(s["cold-viewer"].p95Ms, s.editorial.p95Ms),
    costLowUsd: 0,
    costHighUsd: 0,
    retryShare: Math.max(s["cold-viewer"].retryShare, s.editorial.retryShare),
  };
  // Discovery runs in steps of `discoveryBatch` episodes, and each step waits for its slowest read.
  const discoverySteps =
    work.discovery > 0 ? Math.ceil(work.discovery / profile.discoveryBatch) : 0;
  const discovery =
    stageMs(work.discovery, s.discovery, c, side) +
    Math.max(0, discoverySteps - 1) * (side === "low" ? 0 : s.discovery.p95Ms);
  const ranking =
    stageMs(work.screen, s.screen, c, side) +
    stageMs(2 * work.detailed, detailed, c, side) +
    stageMs(work.comparisons, s.pairwise, c, side);
  const slices = Math.max(1, Math.ceil(ranking / profile.stepBudgetMs));
  return discovery + ranking + slices * SLICE_OVERHEAD_MS[side] + OVERHEAD_MS[side];
}

/** The supplied pack's average episode, on which discovery cost was measured. */
const MEASURED_EPISODE_KB = 10.33;
/** Prompt sizes vary between shows, so the low end allows this much below the measured bill. */
const LOW_COST_ALLOWANCE = 0.8;

export function workCost(
  profile: WorkProfile,
  work: Work,
  side: "low" | "high",
  /** Discovery reads a whole episode, so its cost follows episode length. */
  discoveryScale = 1,
): number | null {
  const s = profile.stages;
  if (!s.discovery || !s.screen || !s["cold-viewer"] || !s.editorial || !s.pairwise) return null;
  const pick = (stage: StageProfile) =>
    side === "low"
      ? stage.costLowUsd * LOW_COST_ALLOWANCE
      : stage.costHighUsd * (1 + stage.retryShare);
  return (
    work.discovery * pick(s.discovery) * discoveryScale +
    work.screen * pick(s.screen) +
    work.detailed * (pick(s["cold-viewer"]) + pick(s.editorial)) +
    work.comparisons * pick(s.pairwise)
  );
}

/**
 * The estimate before an analysis starts. `candidates` is used once discovery
 * has run; before that, the script's size (`textKb`, the uncompressed size of
 * its text files) or failing that its episode count stands in for it.
 */
export function estimateAnalysis(
  profile: WorkProfile,
  input: { episodes: number; requested: number; textKb?: number; candidates?: number },
): AnalysisEstimate {
  const episodes = Math.max(1, input.episodes);
  const range = candidateRange(episodes, input.textKb);
  const pool = (side: "low" | "high") => Math.max(1, input.candidates ?? Math.round(range[side]));
  const low = plannedWork(input.requested, episodes, pool("low"), PASS_SHARE.high);
  const high = plannedWork(input.requested, episodes, pool("high"), PASS_SHARE.low);
  const timeLow = workTime(profile, low, "low");
  const timeHigh = workTime(profile, high, "high");
  const scale =
    input.textKb === undefined
      ? 1
      : Math.min(3, Math.max(0.3, input.textKb / episodes / MEASURED_EPISODE_KB));
  const costLow = workCost(profile, low, "low", scale);
  const costHigh = workCost(profile, high, "high", Math.max(scale, 0.5));
  const costUsd = costLow === null || costHigh === null ? null : { low: costLow, high: costHigh };
  const requests = {
    low: calls(low),
    high: Math.ceil(calls(high) * 1.05),
  };
  const overBudget =
    (costUsd && costUsd.low > profile.budgetUsd) || requests.low > profile.maxRequests
      ? "yes"
      : (costUsd && costUsd.high > profile.budgetUsd) || requests.high > profile.maxRequests
        ? "maybe"
        : "no";
  return {
    work: { low, high },
    requests,
    timeMs: timeLow === null || timeHigh === null ? null : { low: timeLow, high: timeHigh },
    costUsd,
    overBudget,
  };
}

/** "about 4 to 7 minutes", rounded so the range never looks more precise than it is. */
export function describeDuration(range: Range): string {
  const minutes = (ms: number) => ms / 60_000;
  const low = minutes(range.low);
  const high = minutes(range.high);
  if (high < 1) return "under a minute";
  const lo = Math.max(1, Math.floor(low));
  const hi = Math.max(lo + 1, Math.ceil(high));
  return `about ${lo} to ${hi} minutes`;
}

/** "$0.12 to $0.31", with more digits only when the amounts are tiny. */
export function describeCost(range: Range): string {
  const digits = range.high < 0.1 ? 3 : 2;
  return `$${range.low.toFixed(digits)} to $${range.high.toFixed(digits)}`;
}
