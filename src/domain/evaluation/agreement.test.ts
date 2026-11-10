import { describe, expect, it } from "vitest";

import type { JudgmentRecord } from "./annotation";
import { cohenKappa, reviewerAgreement, weightedKappa } from "./agreement";
import { judgmentSchema } from "./rubric";

describe("cohenKappa", () => {
  it("matches a textbook example (20 yes-yes, 5 yes-no, 10 no-yes, 15 no-no gives 0.4)", () => {
    const pairs: Array<[string, string]> = [
      ...Array<[string, string]>(20).fill(["yes", "yes"]),
      ...Array<[string, string]>(5).fill(["yes", "no"]),
      ...Array<[string, string]>(10).fill(["no", "yes"]),
      ...Array<[string, string]>(15).fill(["no", "no"]),
    ];
    expect(cohenKappa(pairs)).toBeCloseTo(0.4, 10);
  });

  it("is undefined when it cannot be computed", () => {
    expect(cohenKappa([["yes", "yes"]])).toBeNull();
    expect(
      cohenKappa([
        ["yes", "yes"],
        ["yes", "yes"],
      ]),
    ).toBeNull();
  });
});

describe("weightedKappa", () => {
  it("is 1 for perfect agreement and -1 for full reversal", () => {
    expect(
      weightedKappa([
        [0, 0],
        [2, 2],
        [4, 4],
      ]),
    ).toBeCloseTo(1, 10);
    expect(
      weightedKappa([
        [0, 4],
        [4, 0],
      ]),
    ).toBeCloseTo(-1, 10);
  });

  it("matches a value worked out by hand", () => {
    // Observed disagreement 1/64; expected disagreement 17/64; kappa = 1 - 1/17.
    expect(
      weightedKappa([
        [0, 0],
        [2, 2],
        [2, 3],
        [4, 4],
      ]),
    ).toBeCloseTo(16 / 17, 10);
  });
});

describe("reviewerAgreement", () => {
  const record = (
    reviewer: string,
    clip: string,
    decision: "keep" | "reject",
    clarity: number,
  ): JudgmentRecord => ({
    reviewer,
    source: "part-b",
    clipKey: clip,
    segments: [],
    judgment: judgmentSchema.parse({
      ratings: { hook: 2, cliffhanger: 2, clarity, emotion: 2, boundaries: 2 },
      decision,
      mainReason: decision === "keep" ? "all-round" : "flat",
      weaknesses: [],
      notes: "",
    }),
  });

  it("compares reviewers only on clips both rated, and keeps judgments apart", () => {
    const { reviewers, pairs } = reviewerAgreement([
      record("R1", "a", "keep", 3),
      record("R1", "b", "reject", 2),
      record("R1", "c", "keep", 4),
      record("R2", "a", "keep", 3),
      record("R2", "b", "keep", 2),
      record("R3", "z", "keep", 3),
    ]);
    expect(reviewers).toEqual(["R1", "R2", "R3"]);
    const pair = pairs.find((p) => p.reviewers.join() === "R1,R2");
    expect(pair).toMatchObject({ sharedClips: 2, decisionAgreement: 0.5 });
    expect(pair?.criteria.clarity.exact).toBe(1);
    expect(pairs.find((p) => p.reviewers.join() === "R1,R3")?.sharedClips).toBe(0);
  });
});
