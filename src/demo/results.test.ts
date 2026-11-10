import { describe, expect, it } from "vitest";

import { promoExportSchema, rankingOutputSchema } from "@/domain/ranking/output";
import { showSchema } from "@/domain/screenplay/schema";
import { createTimeline } from "@/domain/screenplay/timeline";

import { buildDemoResults } from "./results";
import { DEMO_SCENARIOS } from "./scenarios";
import { DEMO_SHOW } from "./show";

describe("the made-up demo data", () => {
  it("is a valid show under the real screenplay contract", () => {
    expect(showSchema.safeParse(DEMO_SHOW).success).toBe(true);
  });

  it.each(DEMO_SCENARIOS)("%s matches the real rank-3 contracts", (scenario) => {
    const { ranking, promos } = buildDemoResults(scenario);
    expect(rankingOutputSchema.safeParse(ranking).success).toBe(true);
    expect(promoExportSchema.safeParse(promos).success).toBe(true);
  });

  const complete = buildDemoResults("complete");
  const shortlist = complete.ranking.shortlist;

  it("covers the states the interface must handle, produced by the real scoring code", () => {
    expect(shortlist[0]?.tier).toBe("excellent");
    expect(shortlist[1]?.segments).toHaveLength(2);
    const weak = shortlist[3];
    expect(weak?.criteria.clarity).toMatchObject({
      rating: 2,
      raw: 3,
      caps: ["mostly-partial-understanding"],
    });
    expect(weak?.editorReview).toContain("clarity-at-the-minimum");
    const rough = shortlist[4];
    expect(rough?.warnings).toEqual(
      expect.arrayContaining(["cuts-line-at-start", "cuts-line-at-end"]),
    );
    expect(rough?.criteria.boundaries.caps).toContain("cuts-spoken-line");
    expect(complete.ranking.incomplete.refusedClips).toHaveLength(1);
    expect(complete.ranking.incomplete.refusedComparisons).toHaveLength(1);
  });

  it("cites only events that exist in the made-up show, with identical text", () => {
    const timeline = createTimeline(DEMO_SHOW);
    for (const rec of shortlist) {
      for (const evidence of [...rec.hook.evidence, ...rec.cliffhanger.evidence]) {
        expect(timeline.event(evidence.eventId)?.text).toBe(evidence.text);
      }
    }
  });

  it("represents a partial run and an empty run honestly", () => {
    expect(buildDemoResults("partial").ranking.status).toBe("partial");
    expect(buildDemoResults("partial").ranking.incomplete.failedClips).toHaveLength(1);
    expect(buildDemoResults("empty").ranking.shortlist).toEqual([]);
  });

  it("says it is made up in its own metadata", () => {
    expect(complete.ranking.versions.models).toEqual({ all: "none, made up for this demo" });
    expect(complete.promos.note).toMatch(/made up/i);
  });
});
