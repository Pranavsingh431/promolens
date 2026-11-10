import { describe, expect, it } from "vitest";

import { fakeCold, fakeEditorial, ferryTimeline } from "../../../tests/support/ranking";
import { DEFAULT_RANKING_CONFIG, assertValidConfig } from "./config";
import { buildEditorialPrompt } from "./prompts/editorial-v1";
import {
  applyEditorialRules,
  deriveClarity,
  essentialGate,
  scoreRatings,
  tierOf,
  weightedScore,
} from "./scoring";
import { clipContext, clipView, lineCuts } from "./windows";

const WEIGHTS = DEFAULT_RANKING_CONFIG.weights;
const segments = [{ episode: 1, startMs: 5_000, endMs: 30_000 }];
const view = clipView(ferryTimeline, segments, { hookMs: 3_000, endingMs: 3_000 });
const user = buildEditorialPrompt(
  view,
  clipContext(ferryTimeline, segments, { contextEvents: 3, contextMs: 8_000 }),
).user;
const cuts = lineCuts(view, segments, DEFAULT_RANKING_CONFIG.boundaries);
const clean = { ...view, events: view.events.map((e) => ({ ...e })) };
const all = (r: number) => ({ hook: r, cliffhanger: r, clarity: r, emotion: r, boundaries: r });

describe("the weighted editorial score", () => {
  it("is 25 times the weighted mean rating, from 0 to 100", () => {
    expect(weightedScore(all(4), WEIGHTS)).toBe(100);
    expect(weightedScore(all(0), WEIGHTS)).toBe(0);
    // 0.3*4 + 0.25*3 + 0.2*2 + 0.15*1 + 0.1*0 = 2.5
    expect(
      weightedScore({ hook: 4, cliffhanger: 3, clarity: 2, emotion: 1, boundaries: 0 }, WEIGHTS),
    ).toBe(62.5);
  });

  it("uses the configured weights, which must add up to 1", () => {
    expect(() => assertValidConfig(DEFAULT_RANKING_CONFIG)).not.toThrow();
    expect(() =>
      assertValidConfig({ ...DEFAULT_RANKING_CONFIG, weights: { ...WEIGHTS, hook: 0.5 } }),
    ).toThrow(/add up to 1/);
  });
});

describe("essential gates stop a high average from hiding a severe weakness", () => {
  it("fail a dramatic clip a new viewer cannot follow, however high its other ratings", () => {
    const ratings = { hook: 4, cliffhanger: 4, clarity: 1, emotion: 4, boundaries: 4 };
    const scored = scoreRatings(ratings, DEFAULT_RANKING_CONFIG);
    expect(scored.score).toBe(85);
    expect(scored.gate).toEqual({ pass: false, failed: ["clarity"] });
    expect(scored.tier).toBe("below-gate");
  });

  it("follow the human rubric's bands above the gate", () => {
    expect(tierOf({ ...all(3), hook: 2 }, 2)).toBe("usable");
    expect(tierOf(all(3), 2)).toBe("strong");
    expect(tierOf({ ...all(3), hook: 4, cliffhanger: 4 }, 2)).toBe("excellent");
    expect(tierOf({ ...all(4), boundaries: 2 }, 2)).toBe("strong");
    expect(essentialGate({ ...all(2), emotion: 0, boundaries: 0 }, 2).pass).toBe(true);
  });
});

describe("cold-viewer clarity", () => {
  it("keeps a supported rating", () => {
    const result = deriveClarity(fakeCold(user), clean);
    expect(result).toMatchObject({ rating: 3, raw: 3, caps: [], unsupported: [] });
  });

  it("treats confident claims with no evidence in the clip as unclear", () => {
    const answer = fakeCold(user, {
      clarity: 4,
      stakes: { text: "Her inheritance.", certainty: "clear", evidence: [] },
      happening: { text: "A heist.", certainty: "clear", evidence: ["C999", "B1"] },
    });
    const result = deriveClarity(answer, clean);
    expect(result.unsupported).toEqual(["happening", "stakes"]);
    expect(result.invalidRefs).toEqual(["C999", "B1"]);
    expect(result.rating).toBe(1);
    expect(result.caps).toEqual(["what-is-happening-unclear", "stakes-unclear"]);
  });

  it("caps essential missing context and a viewer who would not care at 2", () => {
    const answer = fakeCold(user, {
      clarity: 4,
      missingContext: [{ item: "Who the captain is.", essential: true }],
      wouldCare: { verdict: "no", reason: "Too little to go on." },
    });
    expect(deriveClarity(answer, clean)).toMatchObject({
      rating: 2,
      essentialMissing: 1,
      caps: ["essential-context-missing", "would-not-care"],
    });
  });

  it("never raises the model's rating", () => {
    expect(deriveClarity(fakeCold(user, { clarity: 1 }), clean).rating).toBe(1);
  });
});

describe("editorial checks against the clip", () => {
  it("keep ratings whose evidence sits in the right windows", () => {
    const result = applyEditorialRules(fakeEditorial(user, {}), clean, []);
    expect(result.hook.caps).toEqual([]);
    expect(result.cliffhanger.caps).toEqual([]);
    expect(result.evidence.hook.map((e) => e.ref)).toEqual([view.opening[0]?.ref]);
  });

  it("do not let a strong moment at second 15 rescue a weak opening", () => {
    const late = view.events.find((e) => e.startMs >= 15_000);
    const judgment = fakeEditorial(user);
    const result = applyEditorialRules(
      { ...judgment, hook: { ...judgment.hook, rating: 4, evidence: [late?.ref ?? "C9"] } },
      clean,
      [],
    );
    expect(result.hook).toEqual({ rating: 1, raw: 4, caps: ["no-hook-evidence-in-opening"] });
    expect(result.outOfWindowRefs).toEqual([late?.ref]);
  });

  it("cap false cliffhangers and endings that leave nothing open", () => {
    const judgment = fakeEditorial(user);
    const answered = applyEditorialRules(
      {
        ...judgment,
        cliffhanger: { ...judgment.cliffhanger, rating: 4, falseCliffhanger: "already-answered" },
      },
      clean,
      [],
    );
    expect(answered.cliffhanger).toMatchObject({
      rating: 1,
      caps: ["false-cliffhanger:already-answered"],
    });
    const flat = applyEditorialRules(
      { ...judgment, cliffhanger: { ...judgment.cliffhanger, rating: 3, tension: "none" } },
      clean,
      [],
    );
    expect(flat.cliffhanger.rating).toBe(1);
  });

  it("limit a hook that needs earlier episodes to 3", () => {
    const judgment = fakeEditorial(user);
    const result = applyEditorialRules(
      { ...judgment, hook: { ...judgment.hook, rating: 4, needsPriorContext: true } },
      clean,
      [],
    );
    expect(result.hook).toMatchObject({ rating: 3, caps: ["hook-needs-prior-context"] });
  });

  it("limit boundaries to 2 only when an edge cuts a substantial part of a line", () => {
    const judgment = fakeEditorial(user, {
      boundaries: { rating: 4, start: "clean", end: "clean", note: "" },
    });
    expect(cuts.some((c) => c.substantial)).toBe(true);
    expect(applyEditorialRules(judgment, clean, cuts).boundaries.rating).toBe(2);
    const minor = cuts.map((c) => ({ ...c, substantial: false }));
    expect(applyEditorialRules(judgment, clean, minor).boundaries.rating).toBe(4);
  });

  it("record cited events that do not exist", () => {
    const judgment = fakeEditorial(user);
    const result = applyEditorialRules(
      { ...judgment, emotion: { ...judgment.emotion, evidence: ["C404"] } },
      clean,
      [],
    );
    expect(result.invalidRefs).toEqual(["C404"]);
    expect(result.emotion).toMatchObject({ rating: 1, caps: ["no-emotion-evidence"] });
  });
});
