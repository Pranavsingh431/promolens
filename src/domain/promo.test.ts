import { describe, expect, it } from "vitest";

import { promoSchema, totalDurationMs, type Segment } from "./promo";

function promoWith(segments: Segment[]) {
  return {
    id: "promo-1",
    rank: 1,
    segments,
    hook: "A stranger slaps the groom in front of the guests.",
    cliffhanger: "The bride opens the letter and goes pale.",
    whyItWorks: "Public humiliation, then a secret the viewer has not seen yet.",
    rankReason: "Strongest hook and clearest setup for a new viewer.",
  };
}

describe("promoSchema", () => {
  it("accepts a single continuous segment inside the duration limits", () => {
    const result = promoSchema.safeParse(
      promoWith([{ episode: 3, startMs: 12_000, endMs: 42_000 }]),
    );
    expect(result.success).toBe(true);
  });

  it("accepts segments from several episodes in any playback order", () => {
    const result = promoSchema.safeParse(
      promoWith([
        { episode: 9, startMs: 61_000, endMs: 66_000 },
        { episode: 2, startMs: 10_000, endMs: 30_000 },
        { episode: 4, startMs: 0, endMs: 15_000 },
      ]),
    );
    expect(result.success).toBe(true);
  });

  it("accepts promos at exactly 20 and 60 seconds", () => {
    expect(
      promoSchema.safeParse(promoWith([{ episode: 1, startMs: 0, endMs: 20_000 }])).success,
    ).toBe(true);
    expect(
      promoSchema.safeParse(promoWith([{ episode: 1, startMs: 0, endMs: 60_000 }])).success,
    ).toBe(true);
  });

  it("rejects promos shorter than 20 seconds or longer than 60 seconds", () => {
    expect(
      promoSchema.safeParse(promoWith([{ episode: 1, startMs: 0, endMs: 19_990 }])).success,
    ).toBe(false);
    expect(
      promoSchema.safeParse(promoWith([{ episode: 1, startMs: 0, endMs: 60_010 }])).success,
    ).toBe(false);
  });

  it("rejects a segment that ends before it starts", () => {
    const result = promoSchema.safeParse(
      promoWith([{ episode: 1, startMs: 30_000, endMs: 5_000 }]),
    );
    expect(result.success).toBe(false);
  });

  it("rejects segments that reuse the same footage", () => {
    const result = promoSchema.safeParse(
      promoWith([
        { episode: 5, startMs: 10_000, endMs: 25_000 },
        { episode: 5, startMs: 20_000, endMs: 35_000 },
      ]),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      "Segment overlaps segment 1 in episode 5",
    );
  });

  it("allows the same time range in different episodes", () => {
    const result = promoSchema.safeParse(
      promoWith([
        { episode: 5, startMs: 10_000, endMs: 25_000 },
        { episode: 6, startMs: 10_000, endMs: 25_000 },
      ]),
    );
    expect(result.success).toBe(true);
  });

  it("requires a hook, a cliffhanger, and both explanations", () => {
    const result = promoSchema.safeParse({
      ...promoWith([{ episode: 1, startMs: 0, endMs: 30_000 }]),
      hook: "",
      rankReason: "",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toEqual(
      expect.arrayContaining(["hook", "rankReason"]),
    );
  });
});

describe("totalDurationMs", () => {
  it("adds up segment lengths and ignores gaps between them", () => {
    expect(
      totalDurationMs([
        { episode: 1, startMs: 0, endMs: 10_000 },
        { episode: 1, startMs: 50_000, endMs: 62_500 },
      ]),
    ).toBe(22_500);
  });
});
