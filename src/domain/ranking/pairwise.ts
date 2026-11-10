import { createRandom } from "../evaluation/random.ts";

/**
 * Stage E helpers: which pairs to compare, in which order, and how to turn
 * the answers into one ranking.
 *
 * Schedule: finalists are sorted by their individual score and each is
 * compared with the next `window` finalists, wrapping around from the bottom
 * of the order to the top (a circulant design). Every finalist plays exactly
 * 2 x window games, mostly against clips with close scores; the few
 * wrap-around games pit top clips against bottom ones and confirm the ends of
 * the order. That is window x finalists comparisons instead of all pairs.
 * With 2 x window + 1 finalists or fewer, every pair is compared. (An earlier
 * version did not wrap around, which gave the top and bottom clips half as
 * many games; with the prior below, that pulled the top clip toward the
 * middle. The development pilot showed it, so the schedule was changed before
 * the freeze.)
 *
 * Order: a seeded coin per pair decides which clip is shown first. A seeded
 * share of pairs is judged again with the clips swapped. The default share is
 * 1: on real data the judge picked the second-shown clip about three times in
 * four when clips were otherwise equal, so a pair is only trusted across both
 * orders.
 *
 * Aggregation: Bradley-Terry strengths fitted with the standard MM updates.
 * Every pair counts as one game: a pair judged in both orders contributes
 * each judgment at half weight, so two answers that each pick the clip in the
 * same position become a tie and a repeat never gives a clip extra games. A
 * judgment lost to a refusal stays lost: the remaining order keeps its half
 * weight rather than being promoted to a full game. A tie counts half a win
 * for each side. Each finalist also plays `prior` virtual tied games against a neutral
 * anchor of strength 1, which keeps strengths finite when a clip wins or loses
 * every comparison. Equal strengths fall back to the individual score, then
 * the clip key.
 */

export type Finalist = { id: string; clipKey: string; score: number };

export type ScheduledPair = {
  pairId: string;
  /** Shown as clip A. */
  first: string;
  /** Shown as clip B. */
  second: string;
  /** 0 for the main judgment, 1 for the swapped repeat. */
  replicate: number;
};

function byScore(a: Finalist, b: Finalist): number {
  return b.score - a.score || (a.clipKey < b.clipKey ? -1 : a.clipKey > b.clipKey ? 1 : 0);
}

/** Small deterministic hash so a pair's coin does not depend on the rest of the schedule. */
function pairSeed(seed: number, a: string, b: string): number {
  let h = seed >>> 0;
  for (const ch of `${a}|${b}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

export function schedulePairs(
  finalists: readonly Finalist[],
  options: { window: number; repeatShare: number; seed: number },
): ScheduledPair[] {
  const sorted = [...finalists].sort(byScore);
  const n = sorted.length;
  const edges: Array<[number, number]> = [];
  if (n <= 2 * options.window + 1) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) edges.push([i, j]);
  } else {
    for (let i = 0; i < n; i++) {
      for (let d = 1; d <= options.window; d++) edges.push([i, (i + d) % n]);
    }
  }

  const pairs: ScheduledPair[] = [];
  for (const [i, j] of edges) {
    const x = sorted[i] as Finalist;
    const y = sorted[j] as Finalist;
    const [low, high] = x.id < y.id ? [x.id, y.id] : [y.id, x.id];
    const random = createRandom(pairSeed(options.seed, low, high));
    const swap = random() < 0.5;
    const [first, second] = swap ? [high, low] : [low, high];
    const pairId = `${low}|${high}`;
    pairs.push({ pairId, first, second, replicate: 0 });
    if (random() < options.repeatShare) {
      pairs.push({ pairId, first: second, second: first, replicate: 1 });
    }
  }
  return pairs;
}

export type PairJudgment = {
  pairId: string;
  first: string;
  second: string;
  replicate: number;
  /** As answered: "A" means the first-shown clip won. */
  winner: "A" | "B" | "tie";
};

/** The winning candidate id, or null for a tie. */
export function winnerId(judgment: PairJudgment): string | null {
  return judgment.winner === "tie"
    ? null
    : judgment.winner === "A"
      ? judgment.first
      : judgment.second;
}

export type Strength = {
  id: string;
  strength: number;
  wins: number;
  losses: number;
  ties: number;
  comparisons: number;
};

/** How many judgments the schedule planned for each pair, used to weight them. */
export function judgmentsScheduled(schedule: readonly ScheduledPair[]): Map<string, number> {
  const planned = new Map<string, number>();
  for (const pair of schedule) planned.set(pair.pairId, (planned.get(pair.pairId) ?? 0) + 1);
  return planned;
}

export function bradleyTerry(
  ids: readonly string[],
  judgments: readonly PairJudgment[],
  options: {
    prior: number;
    /** Judgments planned per pair. Without it, the judgments received are used. */
    scheduled?: ReadonlyMap<string, number>;
    iterations?: number;
    tolerance?: number;
  },
): Map<string, Strength> {
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const wins = new Array<number>(n).fill(0);
  const games = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const record = ids.map((id) => ({ id, wins: 0, losses: 0, ties: 0, comparisons: 0 }));

  const received = new Map<string, number>();
  for (const j of judgments) received.set(j.pairId, (received.get(j.pairId) ?? 0) + 1);

  for (const j of judgments) {
    const a = index.get(j.first);
    const b = index.get(j.second);
    if (a === undefined || b === undefined || a === b) continue;
    // Each pair is one game in total, however many times it was judged.
    const w = 1 / (options.scheduled?.get(j.pairId) ?? received.get(j.pairId) ?? 1);
    (games[a] as number[])[b] = ((games[a] as number[])[b] ?? 0) + w;
    (games[b] as number[])[a] = ((games[b] as number[])[a] ?? 0) + w;
    const ra = record[a] as Strength;
    const rb = record[b] as Strength;
    ra.comparisons += 1;
    rb.comparisons += 1;
    const winner = winnerId(j);
    if (winner === null) {
      wins[a] = (wins[a] ?? 0) + w / 2;
      wins[b] = (wins[b] ?? 0) + w / 2;
      ra.ties += 1;
      rb.ties += 1;
    } else if (winner === j.first) {
      wins[a] = (wins[a] ?? 0) + w;
      ra.wins += 1;
      rb.losses += 1;
    } else {
      wins[b] = (wins[b] ?? 0) + w;
      rb.wins += 1;
      ra.losses += 1;
    }
  }

  const prior = options.prior;
  let p = new Array<number>(n).fill(1);
  const iterations = options.iterations ?? 1_000;
  const tolerance = options.tolerance ?? 1e-12;
  for (let step = 0; step < iterations; step++) {
    const next = p.map((pi, i) => {
      let denominator = prior / (pi + 1);
      for (let j = 0; j < n; j++) {
        const g = (games[i] as number[])[j] ?? 0;
        if (g > 0) denominator += g / (pi + (p[j] ?? 1));
      }
      const numerator = (wins[i] ?? 0) + prior / 2;
      return denominator > 0 ? numerator / denominator : pi;
    });
    const change = Math.max(...next.map((v, i) => Math.abs(v - (p[i] ?? 0))));
    p = next;
    if (change < tolerance) break;
  }

  return new Map(ids.map((id, i) => [id, { ...(record[i] as Strength), strength: p[i] ?? 1 }]));
}

/** Finalists ordered by strength, then individual score, then clip key. */
export function orderByStrength(
  finalists: readonly Finalist[],
  strengths: ReadonlyMap<string, Strength>,
): Finalist[] {
  return [...finalists].sort((a, b) => {
    const sa = strengths.get(a.id)?.strength ?? 0;
    const sb = strengths.get(b.id)?.strength ?? 0;
    // Strengths within a relative 1e-9 count as equal, so rounding noise never decides an order.
    if (Math.abs(sa - sb) > 1e-9 * Math.max(sa, sb, 1)) return sb - sa;
    return byScore(a, b);
  });
}

export type PairStats = {
  judgments: number;
  ties: number;
  /** Share of decided judgments won by the clip shown first. Near 0.5 means little position bias. */
  firstShownWinShare: number | null;
  /** Exact two-sided binomial test of first-shown wins against one half. */
  positionPValue: number | null;
  /** Pairs judged in both orders. */
  repeatedPairs: number;
  /** Repeated pairs where both orders picked the same clip, or both called a tie. */
  consistent: number;
  /** Repeated pairs where the two orders picked opposite clips. */
  reversed: number;
  /** Reversed pairs where each order chose the clip shown second. */
  reversedTowardSecond: number;
  /** Reversed pairs where each order chose the clip shown first. */
  reversedTowardFirst: number;
};

/** Exact two-sided sign test: how surprising k of n would be if each side were equally likely. */
export function signTestP(k: number, n: number): number | null {
  if (n === 0) return null;
  const smaller = Math.min(k, n - k);
  let term = 0.5 ** n;
  let tail = term;
  for (let i = 0; i < smaller; i++) {
    term *= (n - i) / (i + 1);
    tail += term;
  }
  return Math.min(1, 2 * tail);
}

export function pairStats(judgments: readonly PairJudgment[]): PairStats {
  const decided = judgments.filter((j) => j.winner !== "tie");
  const byPair = new Map<string, PairJudgment[]>();
  for (const j of judgments) byPair.set(j.pairId, [...(byPair.get(j.pairId) ?? []), j]);
  let repeatedPairs = 0;
  let consistent = 0;
  let reversed = 0;
  let reversedTowardSecond = 0;
  let reversedTowardFirst = 0;
  for (const group of byPair.values()) {
    const main = group.find((j) => j.replicate === 0);
    const repeat = group.find((j) => j.replicate === 1);
    if (!main || !repeat) continue;
    repeatedPairs += 1;
    const a = winnerId(main);
    const b = winnerId(repeat);
    if (a === b) consistent += 1;
    else if (a !== null && b !== null) {
      reversed += 1;
      if (main.winner === "B") reversedTowardSecond += 1;
      else reversedTowardFirst += 1;
    }
  }
  const firstWins = decided.filter((j) => j.winner === "A").length;
  return {
    judgments: judgments.length,
    ties: judgments.length - decided.length,
    firstShownWinShare: decided.length ? firstWins / decided.length : null,
    positionPValue: signTestP(firstWins, decided.length),
    repeatedPairs,
    consistent,
    reversed,
    reversedTowardSecond,
    reversedTowardFirst,
  };
}

/** Kendall's tau-b between two orderings of the same ids. 1 means identical order. */
export function kendallTau(a: readonly string[], b: readonly string[]): number | null {
  const position = new Map(b.map((id, i) => [id, i]));
  const shared = a.filter((id) => position.has(id));
  if (shared.length < 2) return null;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < shared.length; i++) {
    for (let j = i + 1; j < shared.length; j++) {
      const d = (position.get(shared[i] as string) ?? 0) - (position.get(shared[j] as string) ?? 0);
      if (d < 0) concordant += 1;
      else if (d > 0) discordant += 1;
    }
  }
  const total = concordant + discordant;
  return total ? (concordant - discordant) / total : null;
}
