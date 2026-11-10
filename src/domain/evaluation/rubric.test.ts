import { describe, expect, it } from "vitest";

import {
  CRITERIA,
  ESSENTIAL_CRITERIA,
  judgmentSchema,
  overallAssessment,
  relevanceGain,
  type Judgment,
} from "./rubric";

const judgment = (ratings: number[], decision: "keep" | "reject", mainReason: string): unknown => ({
  ratings: {
    hook: ratings[0],
    cliffhanger: ratings[1],
    clarity: ratings[2],
    emotion: ratings[3],
    boundaries: ratings[4],
  },
  decision,
  mainReason,
  weaknesses: [],
  notes: "",
});

const parse = (value: unknown) => judgmentSchema.parse(value) as Judgment;

describe("rubric definition", () => {
  it("has five criteria with five described levels each, three of them essential", () => {
    expect(CRITERIA.map((c) => c.id)).toEqual([
      "hook",
      "cliffhanger",
      "clarity",
      "emotion",
      "boundaries",
    ]);
    expect(CRITERIA.every((c) => c.levels.length === 5)).toBe(true);
    expect(ESSENTIAL_CRITERIA).toEqual(["hook", "cliffhanger", "clarity"]);
  });
});

describe("judgmentSchema", () => {
  it("accepts a complete keep and a complete reject", () => {
    expect(judgmentSchema.safeParse(judgment([3, 3, 3, 2, 2], "keep", "strong-hook")).success).toBe(
      true,
    );
    expect(judgmentSchema.safeParse(judgment([0, 1, 1, 0, 0], "reject", "no-hook")).success).toBe(
      true,
    );
  });

  it("refuses to keep a clip a new viewer cannot follow", () => {
    const result = judgmentSchema.safeParse(judgment([4, 4, 1, 4, 4], "keep", "strong-hook"));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual(["ratings.clarity"]);
  });

  it("requires a reason that matches the decision", () => {
    expect(judgmentSchema.safeParse(judgment([3, 3, 3, 2, 2], "keep", "no-hook")).success).toBe(
      false,
    );
    expect(
      judgmentSchema.safeParse(judgment([1, 1, 1, 1, 1], "reject", "strong-hook")).success,
    ).toBe(false);
  });

  it("rejects ratings outside 0 to 4 and repeated weaknesses", () => {
    expect(judgmentSchema.safeParse(judgment([5, 3, 3, 2, 2], "keep", "all-round")).success).toBe(
      false,
    );
    expect(judgmentSchema.safeParse(judgment([2.5, 3, 3, 2, 2], "keep", "all-round")).success).toBe(
      false,
    );
    const repeated = {
      ...(judgment([1, 1, 1, 1, 1], "reject", "flat") as object),
      weaknesses: ["slow-start", "slow-start"],
    };
    expect(judgmentSchema.safeParse(repeated).success).toBe(false);
  });
});

describe("overall assessment and gain", () => {
  it.each([
    [[4, 4, 4, 4, 4], "reject", "duplicate", "reject", 0],
    [[2, 4, 4, 4, 4], "keep", "all-round", "usable", 1],
    [[3, 3, 3, 0, 0], "keep", "all-round", "strong", 2],
    [[4, 4, 3, 1, 2], "keep", "all-round", "strong", 2],
    [[4, 4, 3, 1, 3], "keep", "all-round", "excellent", 3],
    [[4, 3, 3, 4, 4], "keep", "all-round", "strong", 2],
  ] as const)("%j %s is %s with gain %i", (ratings, decision, reason, overall, gain) => {
    const value = parse(judgment([...ratings], decision, reason));
    expect(overallAssessment(value)).toBe(overall);
    expect(relevanceGain(value)).toBe(gain);
  });
});
