import { describe, expect, it } from "vitest";

import { buildDemoResults } from "@/demo/results";

import { buildResultsModel } from "./results-model";

const complete = buildResultsModel(buildDemoResults("complete"));

describe("the results model", () => {
  it("lists the shortlist as recommended, in shortlist order", () => {
    expect(complete.recommended.map((r) => r.displayRank)).toEqual([1, 2, 3, 4, 5]);
    expect(complete.recommended.every((r) => r.status === "recommended")).toBe(true);
  });

  it("lists other passing clips as alternatives and links a repeat to what it repeats", () => {
    expect(complete.alternatives).toHaveLength(2);
    const repeat = complete.alternatives.find((r) => r.repeatOf);
    expect(repeat?.repeatOf?.rank).toBe(1);
    expect(repeat?.status).toBe("alternative");
  });

  it("flags needs-review without changing a clip's status or score", () => {
    const flagged = complete.recommended.filter((r) => r.review.length);
    expect(flagged.map((r) => r.displayRank)).toEqual([3, 4, 5]);
    expect(flagged.every((r) => r.status === "recommended")).toBe(true);
    expect(complete.recommended[3]?.review[0]?.label).toBe("Check clarity");
  });

  it("keeps refused clips apart, with exact times and no score", () => {
    expect(complete.unevaluated).toEqual([
      expect.objectContaining({
        reason: "provider-refused",
        durationMs: 24_000,
        segments: [{ episode: 3, startMs: 0, endMs: 24_000 }],
      }),
    ]);
  });

  it("separates a failed evaluation from a provider refusal, and marks the run partial", () => {
    const partial = buildResultsModel(buildDemoResults("partial"));
    expect(partial.partial).toBe(true);
    expect(partial.unevaluated.map((r) => r.reason).sort()).toEqual(["failed", "provider-refused"]);
  });

  it("does not count clips screening set aside as incomplete", () => {
    expect(complete.notAssessed).toBe(1);
    expect(complete.unevaluated.some((r) => r.id.includes("0050000"))).toBe(false);
  });

  it("is empty when nothing passed", () => {
    const empty = buildResultsModel(buildDemoResults("empty"));
    expect(empty.recommended).toEqual([]);
    expect(empty.alternatives).toEqual([]);
    expect(empty.unevaluated).toEqual([]);
  });

  it("puts important warnings before minor ones", () => {
    const withCuts = complete.recommended[4];
    expect(withCuts?.warnings[0]?.severity).toBe("important");
    expect(withCuts?.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["cuts-line-at-start", "cuts-line-at-end"]),
    );
  });
});
