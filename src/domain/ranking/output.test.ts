import { describe, expect, it } from "vitest";

import {
  fakeCold,
  fakeEditorial,
  ferryTimeline,
  makeCandidate,
} from "../../../tests/support/ranking";
import { candidateSetSchema } from "../evaluation/candidate";
import { emptyAssessment, scoreAssessment } from "./assemble";
import { DEFAULT_RANKING_CONFIG } from "./config";
import {
  PROMO_EXPORT_FORMAT,
  buildRecommendation,
  editorReviewReasons,
  listEntry,
  promoExportSchema,
  quotesNotInClip,
  recommendationSchema,
  renderPromosCsv,
  warningsFor,
  type PromoExport,
  type Recommendation,
} from "./output";
import { buildEditorialPrompt } from "./prompts/editorial-v1";
import { screenDeterministic } from "./screening";
import { clipContext } from "./windows";

const candidate = makeCandidate(ferryTimeline, [{ episode: 1, startMs: 4_500, endMs: 26_000 }], {
  cues: ["src:ai-screen-only", "src:cues"],
});
const [stageA] = screenDeterministic([candidate], ferryTimeline, DEFAULT_RANKING_CONFIG);
if (!stageA) throw new Error("no stage A");
const user = buildEditorialPrompt(
  stageA.view,
  clipContext(ferryTimeline, candidate.segments, DEFAULT_RANKING_CONFIG.windows),
).user;
const assessed = scoreAssessment(
  {
    ...emptyAssessment(candidate, stageA),
    selection: "priority",
    cold: fakeCold(user),
    editorial: fakeEditorial(user),
    deepStatus: "ok",
  },
  DEFAULT_RANKING_CONFIG,
);
const build = () =>
  buildRecommendation({
    rank: 1,
    assessment: assessed,
    listPosition: 1,
    scoreRank: 1,
    strength: { id: candidate.id, strength: 1.4, wins: 2, losses: 0, ties: 1, comparisons: 3 },
    diversity: { maxSimilarity: 0, nearest: null },
  });

describe("an editor-ready recommendation", () => {
  it("has ordered segments with exact times, evidence, rationale, scores, and provenance", () => {
    const rec = build();
    expect(rec.segments).toEqual([
      { episode: 1, startMs: 4_500, endMs: 26_000, start: "00:04.50", end: "00:26.00" },
    ]);
    expect(rec.durationMs).toBe(21_500);
    expect(rec.hook.evidence[0]).toMatchObject({
      eventId: expect.stringMatching(/^E001-/),
      promoStartS: expect.any(Number),
    });
    expect(rec.hook.evidence.every((e) => e.promoStartS < 3)).toBe(true);
    // Evidence times are the on-screen part: nothing before the cut or after the end.
    for (const e of [...rec.hook.evidence, ...rec.cliffhanger.evidence]) {
      expect(e.start >= "00:04.50" && e.end <= "00:26.00").toBe(true);
    }
    expect(rec.cliffhanger.evidence.every((e) => e.promoEndS > 21.5 - 3)).toBe(true);
    expect(rec.whyItWorks.length).toBeGreaterThan(0);
    expect(Object.keys(rec.criteria)).toEqual([
      "hook",
      "cliffhanger",
      "clarity",
      "emotion",
      "boundaries",
    ]);
    expect(rec.provenance.methods).toEqual(["ai-screen-only", "cues"]);
    expect(rec.ranking.reason).toContain("won 2, lost 0, tied 1 of 3");
    expect(rec.ranking.reason).not.toMatch(/probab|viral/i);
  });

  it("rejects hook evidence after the first 3 s and ending evidence before the last 3 s", () => {
    const rec = build();
    const late = {
      ...rec.hook.evidence[0],
      promoStartS: 12,
    } as Recommendation["hook"]["evidence"][number];
    expect(
      recommendationSchema.safeParse({ ...rec, hook: { ...rec.hook, evidence: [late] } }).success,
    ).toBe(false);
    const early = {
      ...rec.cliffhanger.evidence[0],
      promoEndS: 5,
    } as Recommendation["cliffhanger"]["evidence"][number];
    expect(
      recommendationSchema.safeParse({
        ...rec,
        cliffhanger: { ...rec.cliffhanger, evidence: [early] },
      }).success,
    ).toBe(false);
  });

  it("rejects missing evidence, wrong durations, and clips outside 20 to 60 s", () => {
    const rec = build();
    expect(
      recommendationSchema.safeParse({ ...rec, hook: { ...rec.hook, evidence: [] } }).success,
    ).toBe(false);
    expect(recommendationSchema.safeParse({ ...rec, durationMs: 30_000 }).success).toBe(false);
    const long = {
      ...rec,
      segments: [{ ...rec.segments[0], endMs: 70_000, end: "01:10.00" }],
      durationMs: 65_500,
    };
    expect(recommendationSchema.safeParse(long).success).toBe(false);
  });

  it("refuses to build from a clip that was not fully assessed", () => {
    expect(() =>
      buildRecommendation({
        rank: 1,
        assessment: { ...assessed, cold: null },
        listPosition: 1,
        scoreRank: 1,
        strength: null,
        diversity: { maxSimilarity: 0, nearest: null },
      }),
    ).toThrow(/not fully assessed/);
  });
});

describe("what an editor is told to check", () => {
  it("flags an essential rating at the minimum without changing it", () => {
    const low = {
      ...assessed,
      scored: {
        ...(assessed.scored as NonNullable<typeof assessed.scored>),
        ratings: { hook: 4, cliffhanger: 3, clarity: 2, emotion: 3, boundaries: 3 },
      },
    };
    expect(editorReviewReasons(low, 2, 0)).toEqual(["clarity-at-the-minimum"]);
    expect(low.scored.ratings.clarity).toBe(2);
    expect(editorReviewReasons(low, 2, 1)).toEqual([
      "clarity-at-the-minimum",
      "comparison-refused:1",
    ]);
  });

  it("records refused comparisons on the recommendation", () => {
    const rec = buildRecommendation({
      rank: 1,
      assessment: assessed,
      listPosition: 1,
      scoreRank: 1,
      strength: { id: candidate.id, strength: 1.4, wins: 2, losses: 0, ties: 0, comparisons: 2 },
      diversity: { maxSimilarity: 0, nearest: null },
      refusedComparisons: 1,
    });
    expect(rec.ranking.pairwise?.refused).toBe(1);
    expect(rec.editorReview).toContain("comparison-refused:1");
  });
});

describe("quotes in model text", () => {
  const { view } = stageA;
  const line = view.events.find((e) => e.kind === "dialogue")?.text ?? "";

  it("accepts quotes that match the clip, ignoring case, punctuation, and curly quotes", () => {
    const quoted = line.replace(/[.!?]+$/, "").toUpperCase();
    expect(quotesNotInClip([`She says “${quoted}!”`], view)).toEqual([]);
  });

  it("reports a quoted line the clip does not contain", () => {
    expect(quotesNotInClip([`He whispers "the treasure is mine"`], view)).toEqual([
      "the treasure is mine",
    ]);
  });

  it("does not treat apostrophes as quotes", () => {
    expect(quotesNotInClip(["Mara's brother won't talk."], view)).toEqual([]);
  });

  it("warns on a recommendation built from invented dialogue", () => {
    const invented = {
      ...assessed,
      editorial: {
        ...(assessed.editorial as NonNullable<typeof assessed.editorial>),
        whyItWorks: `It ends on "words nobody ever said here".`,
      },
    };
    expect(warningsFor(invented)).toContain("model-quote-not-in-clip");
    expect(warningsFor(assessed)).not.toContain("model-quote-not-in-clip");
  });
});

describe("list entries", () => {
  it("say whether a judgment exists, apart from the clip's position", () => {
    const entry = (status: Parameters<typeof listEntry>[1]) => listEntry(1, status, assessed);
    expect(entry("finalist")).toMatchObject({ evaluation: "complete", manualReview: false });
    expect(entry("not-assessed")).toMatchObject({ evaluation: "not-run", manualReview: false });
    expect(entry("provider-refused")).toMatchObject({
      evaluation: "provider-refused",
      manualReview: true,
    });
    expect(entry("assessment-failed")).toMatchObject({ evaluation: "failed", manualReview: true });
  });
});

describe("the promo export", () => {
  const rec = build();
  const data: PromoExport = promoExportSchema.parse({
    format: PROMO_EXPORT_FORMAT,
    runId: "r",
    createdAt: "2026-11-10T00:00:00.000Z",
    packSha256: "0".repeat(64),
    rankingVersion: "rank-3",
    configHash: "abc",
    status: "complete",
    note: "n",
    promos: [{ shortlistRank: 1, alternateOf: null, promo: rec }],
  });

  it("writes exact segments and rationale for every promo", () => {
    const csv = renderPromosCsv(data);
    const [header, row] = csv.trim().split("\r\n");
    expect(header).toContain("hook");
    expect(header).toContain("why_it_works");
    expect(row).toContain("E001 00:04.50 to 00:26.00");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("escapes quotes and commas and neutralizes spreadsheet formulas", () => {
    const risky = {
      ...data,
      promos: [
        {
          shortlistRank: null,
          alternateOf: null,
          promo: {
            ...rec,
            whyItWorks: `=HYPERLINK("http://x")`,
            hook: { ...rec.hook, explanation: `He says "stop", then runs` },
          },
        },
      ],
    };
    const csv = renderPromosCsv(risky);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain(`"He says ""stop"", then runs"`);
  });
});

describe("the ranked candidate set", () => {
  it("is a valid Phase 2 candidate set", () => {
    const set = {
      method: "ranked",
      methodVersion: "rank-1|test",
      packSha256: "0".repeat(64),
      candidates: [
        {
          ...candidate,
          id: `ranked:${candidate.clipKey}`,
          method: "ranked",
          methodVersion: "rank-1|test",
        },
      ],
      rejected: {},
      proposals: 1,
    };
    expect(() => candidateSetSchema.parse(set)).not.toThrow();
  });
});
