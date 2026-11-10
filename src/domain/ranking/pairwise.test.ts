import { describe, expect, it } from "vitest";

import { createRandom } from "../evaluation/random";
import {
  bradleyTerry,
  judgmentsScheduled,
  kendallTau,
  orderByStrength,
  pairStats,
  schedulePairs,
  signTestP,
  winnerId,
  type Finalist,
  type PairJudgment,
} from "./pairwise";

const finalists: Finalist[] = [
  { id: "a", clipKey: "E001@1", score: 90 },
  { id: "b", clipKey: "E001@2", score: 80 },
  { id: "c", clipKey: "E001@3", score: 70 },
  { id: "d", clipKey: "E001@4", score: 60 },
  { id: "e", clipKey: "E001@5", score: 50 },
];
const OPTIONS = { window: 2, repeatShare: 0, seed: 1 };

/** Judges every scheduled pair with a fixed true order, in whatever order it was shown. */
function judgeAll(order: string[], pairs = schedulePairs(finalists, OPTIONS)): PairJudgment[] {
  return pairs.map((p) => ({
    ...p,
    winner: order.indexOf(p.first) < order.indexOf(p.second) ? "A" : "B",
  }));
}

describe("the comparison schedule", () => {
  const ten: Finalist[] = Array.from({ length: 10 }, (_, i) => ({
    id: `f${i}`,
    clipKey: `E001@${i}`,
    score: 90 - i,
  }));
  const games = (pairs: ReturnType<typeof schedulePairs>, ids: string[]) =>
    ids.map((id) => pairs.filter((p) => p.first === id || p.second === id).length);

  it("gives every finalist the same number of comparisons, not every pair", () => {
    const pairs = schedulePairs(ten, OPTIONS);
    // window 2: 4 games each, 10 x 4 / 2 = 20 pairs instead of 45.
    expect(pairs).toHaveLength(20);
    expect(new Set(pairs.map((p) => p.pairId)).size).toBe(20);
    expect(
      games(
        pairs,
        ten.map((f) => f.id),
      ),
    ).toEqual(new Array(10).fill(4));
  });

  it("compares neighbours in score order, wrapping from the bottom to the top", () => {
    const pairs = schedulePairs(ten, OPTIONS);
    const has = (a: string, b: string) => pairs.some((p) => p.pairId === [a, b].sort().join("|"));
    expect(has("f0", "f1") && has("f0", "f2") && has("f4", "f6")).toBe(true);
    expect(has("f9", "f0") && has("f8", "f0") && has("f9", "f1")).toBe(true);
    expect(has("f4", "f9")).toBe(false);
  });

  it("gives the top-scored finalist as many games as any other (regression)", () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => ({
      id: `g${i}`,
      clipKey: `k${i}`,
      score: 100 - i,
    }));
    const pairs = schedulePairs(sixteen, { ...OPTIONS, window: 3 });
    expect(
      games(
        pairs,
        sixteen.map((f) => f.id),
      ),
    ).toEqual(new Array(16).fill(6));
  });

  it("compares everyone when there are too few finalists for the window", () => {
    expect(schedulePairs(finalists, OPTIONS)).toHaveLength(10);
  });

  it("decides which clip is shown first with a seeded coin", () => {
    const one = schedulePairs(ten, OPTIONS);
    expect(schedulePairs([...ten].reverse(), OPTIONS)).toEqual(one);
    const position = (id: string) => ten.findIndex((f) => f.id === id);
    expect(new Set(one.map((p) => position(p.first) < position(p.second)))).toEqual(
      new Set([true, false]),
    );
    expect(schedulePairs(ten, { ...OPTIONS, seed: 2 }).map((p) => p.first)).not.toEqual(
      one.map((p) => p.first),
    );
  });

  it("repeats a share of pairs with the clips swapped", () => {
    const pairs = schedulePairs(ten, { ...OPTIONS, repeatShare: 1 });
    expect(pairs).toHaveLength(40);
    const main = pairs.filter((p) => p.replicate === 0);
    const repeat = pairs.filter((p) => p.replicate === 1);
    for (const r of repeat) {
      const m = main.find((x) => x.pairId === r.pairId);
      expect([r.first, r.second]).toEqual([m?.second, m?.first]);
    }
  });
});

describe("Bradley-Terry aggregation", () => {
  it("recovers a consistent order from the scheduled comparisons", () => {
    const truth = ["c", "a", "e", "b", "d"];
    const strengths = bradleyTerry(
      finalists.map((f) => f.id),
      judgeAll(truth, schedulePairs(finalists, OPTIONS)),
      { prior: 1 },
    );
    expect(orderByStrength(finalists, strengths).map((f) => f.id)).toEqual(truth);
  });

  it("counts a tie as half a win each and keeps strengths finite", () => {
    const judgments: PairJudgment[] = [
      { pairId: "a|b", first: "a", second: "b", replicate: 0, winner: "tie" },
      { pairId: "a|c", first: "a", second: "c", replicate: 0, winner: "A" },
    ];
    const s = bradleyTerry(["a", "b", "c"], judgments, { prior: 1 });
    expect(s.get("a")).toMatchObject({ wins: 1, losses: 0, ties: 1, comparisons: 2 });
    for (const value of s.values()) expect(Number.isFinite(value.strength)).toBe(true);
    expect((s.get("a")?.strength ?? 0) > (s.get("c")?.strength ?? 0)).toBe(true);
  });

  it("counts a pair judged twice as one game, and opposite answers as a tie", () => {
    const flipped: PairJudgment[] = [
      { pairId: "a|b", first: "a", second: "b", replicate: 0, winner: "A" },
      { pairId: "a|b", first: "b", second: "a", replicate: 1, winner: "A" },
    ];
    const s = bradleyTerry(["a", "b"], flipped, { prior: 1 });
    expect(s.get("a")?.strength).toBeCloseTo(s.get("b")?.strength ?? 0, 9);
    const once: PairJudgment[] = [
      { pairId: "a|b", first: "a", second: "b", replicate: 0, winner: "A" },
    ];
    const twice: PairJudgment[] = [
      ...once,
      { ...once[0], first: "b", second: "a", replicate: 1, winner: "B" } as PairJudgment,
    ];
    const one = bradleyTerry(["a", "b"], once, { prior: 1 });
    const two = bradleyTerry(["a", "b"], twice, { prior: 1 });
    expect(two.get("a")?.strength).toBeCloseTo(one.get("a")?.strength ?? 0, 9);
  });

  it("keeps a lone order at half a game when the other order was lost", () => {
    const once: PairJudgment[] = [
      { pairId: "a|b", first: "a", second: "b", replicate: 0, winner: "A" },
    ];
    const planned = new Map([["a|b", 2]]);
    const half = bradleyTerry(["a", "b"], once, { prior: 1, scheduled: planned });
    const full = bradleyTerry(["a", "b"], once, { prior: 1 });
    const gap = (m: typeof half) => (m.get("a")?.strength ?? 0) - (m.get("b")?.strength ?? 0);
    expect(gap(half)).toBeGreaterThan(0);
    expect(gap(half)).toBeLessThan(gap(full));
  });

  it("breaks equal strengths by individual score, then clip key, never by input order", () => {
    const allTies = schedulePairs(finalists, OPTIONS).map((p) => ({
      ...p,
      winner: "tie" as const,
    }));
    const s = bradleyTerry(
      finalists.map((f) => f.id),
      allTies,
      { prior: 1 },
    );
    const sameScore = finalists.map((f) => ({ ...f, score: 50 }));
    expect(orderByStrength(finalists, s).map((f) => f.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(orderByStrength([...sameScore].reverse(), s).map((f) => f.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("gives the same strengths for the same judgments in any order", () => {
    const judgments = judgeAll(["b", "a", "c", "d", "e"]);
    const ids = finalists.map((f) => f.id);
    const one = [...bradleyTerry(ids, judgments, { prior: 1 }).values()].map((v) => v.strength);
    const two = [...bradleyTerry(ids, [...judgments].reverse(), { prior: 1 }).values()].map(
      (v) => v.strength,
    );
    two.forEach((v, i) => expect(v).toBeCloseTo(one[i] ?? 0, 9));
  });
});

describe("position bias and consistency", () => {
  it("measure first-shown wins and swapped-order agreement", () => {
    const judgments: PairJudgment[] = [
      { pairId: "a|b", first: "a", second: "b", replicate: 0, winner: "A" },
      { pairId: "a|b", first: "b", second: "a", replicate: 1, winner: "B" },
      { pairId: "c|d", first: "c", second: "d", replicate: 0, winner: "A" },
      { pairId: "c|d", first: "d", second: "c", replicate: 1, winner: "A" },
      { pairId: "e|a", first: "e", second: "a", replicate: 0, winner: "tie" },
    ];
    expect(winnerId(judgments[1] as PairJudgment)).toBe("a");
    expect(pairStats(judgments)).toEqual({
      judgments: 5,
      ties: 1,
      firstShownWinShare: 0.75,
      positionPValue: 0.625,
      repeatedPairs: 2,
      consistent: 1,
      reversed: 1,
      reversedTowardSecond: 0,
      reversedTowardFirst: 1,
    });
  });

  it("gives exact sign-test values", () => {
    expect(signTestP(0, 0)).toBeNull();
    expect(signTestP(3, 6)).toBe(1);
    expect(signTestP(0, 5)).toBeCloseTo(1 / 16, 12);
    expect(signTestP(5, 5)).toBeCloseTo(1 / 16, 12);
    expect(signTestP(19, 59)).toBeGreaterThan(0.005);
    expect(signTestP(19, 59)).toBeLessThan(0.01);
  });

  it("counts reversals by the position the judge chose", () => {
    const judgments: PairJudgment[] = [
      { pairId: "a|b", first: "a", second: "b", replicate: 0, winner: "B" },
      { pairId: "a|b", first: "b", second: "a", replicate: 1, winner: "B" },
    ];
    expect(pairStats(judgments)).toMatchObject({
      reversed: 1,
      reversedTowardSecond: 1,
      reversedTowardFirst: 0,
      consistent: 0,
    });
  });

  it("Kendall tau is 1 for the same order and -1 for the reverse", () => {
    expect(kendallTau(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
    expect(kendallTau(["a", "b", "c"], ["c", "b", "a"])).toBe(-1);
    expect(kendallTau(["a"], ["a"])).toBeNull();
  });
});

describe("a judge that prefers the clip shown second", () => {
  const logistic = (x: number) => 1 / (1 + Math.exp(-x));
  const sixteen: Finalist[] = Array.from({ length: 16 }, (_, i) => ({
    id: `c${String(i).padStart(2, "0")}`,
    clipKey: `E001@${i}`,
    score: 50,
  }));
  const trueStrength = (id: string) => (15 - Number(id.slice(1))) * 0.35;
  const trueOrder = sixteen.map((f) => f.id);
  const SECOND_SHOWN_LOGIT = 1;

  function judgeWithBias(repeatShare: number, seed: number): number {
    const schedule = schedulePairs(sixteen, { window: 3, repeatShare, seed });
    const random = createRandom(seed + 1);
    const judgments: PairJudgment[] = schedule.map((p) => ({
      ...p,
      winner:
        random() < logistic(trueStrength(p.first) - trueStrength(p.second) - SECOND_SHOWN_LOGIT)
          ? "A"
          : "B",
    }));
    const strengths = bradleyTerry(
      sixteen.map((f) => f.id),
      judgments,
      { prior: 1, scheduled: judgmentsScheduled(schedule) },
    );
    const order = orderByStrength(sixteen, strengths).map((f) => f.id);
    return kendallTau(order, trueOrder) ?? 0;
  }

  const meanTau = (repeatShare: number) => {
    let total = 0;
    for (let seed = 1; seed <= 300; seed++) total += judgeWithBias(repeatShare, seed * 97);
    return total / 300;
  };

  it("recovers the true order better when every pair is judged in both orders", () => {
    const oneOrder = meanTau(0);
    const both = meanTau(1);
    expect(both).toBeGreaterThan(oneOrder + 0.02);
    expect(both).toBeGreaterThan(0.6);
  });

  it("calls two equal clips a tie when each order picks whichever clip is second", () => {
    const pair = schedulePairs(
      [
        { id: "x", clipKey: "E001@1", score: 1 },
        { id: "y", clipKey: "E001@2", score: 1 },
      ],
      { window: 3, repeatShare: 1, seed: 5 },
    );
    expect(pair).toHaveLength(2);
    const judgments: PairJudgment[] = pair.map((p) => ({ ...p, winner: "B" }));
    const s = bradleyTerry(["x", "y"], judgments, {
      prior: 1,
      scheduled: judgmentsScheduled(pair),
    });
    expect(s.get("x")?.strength).toBeCloseTo(s.get("y")?.strength ?? 0, 9);
  });

  it("shows every pair in both orders at full balance", () => {
    const pairs = schedulePairs(sixteen, { window: 3, repeatShare: 1, seed: 11 });
    expect(pairs).toHaveLength(96);
    const planned = judgmentsScheduled(pairs);
    expect([...planned.values()].every((n) => n === 2)).toBe(true);
    const shownFirst = new Map<string, number>();
    for (const p of pairs) shownFirst.set(p.first, (shownFirst.get(p.first) ?? 0) + 1);
    expect([...shownFirst.values()].every((n) => n === 6)).toBe(true);
  });
});
