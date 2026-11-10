import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  fakeCold,
  fakeEditorial,
  fakePair,
  fakeScreen,
  ferryShow,
  ferryTimeline,
  makeCandidate,
  refsIn,
} from "../../../tests/support/ranking";
import type { Candidate, Interval } from "../../domain/evaluation/candidate";
import { DEFAULT_RANKING_CONFIG, type RankingConfig } from "../../domain/ranking/config";
import { recommendationSchema } from "../../domain/ranking/output";
import type { EditorialResponse } from "../../domain/ranking/prompts/editorial-v1";
import type { ScreenResponse } from "../../domain/ranking/prompts/screen-v1";
import { InferenceError } from "../inference/errors";
import { SpendGuard } from "../inference/limits";
import {
  runRanking,
  type RankingModels,
  type StageCall,
  type StageModel,
  type StageName,
} from "./run";

const root = mkdtempSync(join(tmpdir(), "promolens-rank-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const freshDir = () => join(root, `cache-${++dirs}`);

const INTERVALS: Interval[] = [
  { episode: 1, startMs: 0, endMs: 25_000 },
  { episode: 1, startMs: 4_500, endMs: 30_000 },
  { episode: 1, startMs: 10_000, endMs: 45_000 },
  { episode: 1, startMs: 20_000, endMs: 45_000 },
  { episode: 2, startMs: 0, endMs: 30_000 },
  { episode: 2, startMs: 5_000, endMs: 36_250 },
  { episode: 2, startMs: 12_000, endMs: 40_000 },
  { episode: 3, startMs: 0, endMs: 24_500 },
];
const POOL: Candidate[] = INTERVALS.map((interval, i) =>
  makeCandidate(ferryTimeline, [interval], { cues: [i % 2 ? "src:cues" : "src:ai-screen-only"] }),
);

const model = (id: string, stage: StageName): StageModel => ({
  model: id,
  maxTokens: stage === "screen" ? 3_000 : 6_000,
  reasoningEffort: stage === "screen" ? null : "low",
  privacy: "strict-zdr",
});
const MODELS: RankingModels = {
  screen: model("mock/screen", "screen"),
  "cold-viewer": model("mock/judge", "cold-viewer"),
  editorial: model("mock/judge", "editorial"),
  pairwise: model("mock/judge", "pairwise"),
  secondJudge: null,
};
const CONFIG: RankingConfig = {
  ...DEFAULT_RANKING_CONFIG,
  screening: { ...DEFAULT_RANKING_CONFIG.screening, shortlist: 5, explore: 1 },
  pairwise: { ...DEFAULT_RANKING_CONFIG.pairwise, finalists: 4, repeatShare: 0.5 },
  diversity: { ...DEFAULT_RANKING_CONFIG.diversity, top: 3 },
};

type Request = { stage: StageName; model: string; system: string; user: string };

/** Only the clip itself, without the outside events the editorial prompt also shows. */
const clipOf = (user: string) => /<clip>([\s\S]*?)<\/clip>/.exec(user)?.[1] ?? user;
const OPENS_ON_WIDE_SHOT = "Wide shot of a ferry";
const EPISODE_TWO_LINE = "Those names are not yours to read";

function fakeModel(
  options: {
    fail?: (stage: StageName, user: string) => InferenceError | null;
    editorial?: (user: string) => Partial<EditorialResponse>;
    screen?: (user: string) => Partial<ScreenResponse>;
    guard?: SpendGuard;
  } = {},
) {
  const requests: Request[] = [];
  const call: StageCall = async (stage, m, request) => {
    requests.push({ stage, model: m.model, system: request.system, user: request.user });
    if (options.guard) options.guard.settle(options.guard.reserve(0.01), 0.01);
    const error = options.fail?.(stage, request.user);
    if (error) throw error;
    const answer =
      stage === "screen"
        ? fakeScreen(request.user, options.screen?.(request.user))
        : stage === "cold-viewer"
          ? fakeCold(request.user)
          : stage === "editorial"
            ? fakeEditorial(request.user, options.editorial?.(request.user))
            : (() => {
                const a = refsIn(request.user, "A").all.length;
                const b = refsIn(request.user, "B").all.length;
                return fakePair({ winner: a > b ? "A" : b > a ? "B" : "tie" });
              })();
    return {
      value: request.parse(answer),
      spend: {
        usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 10, cachedTokens: 0 },
        billedUsd: 0.0001,
        estimatedUsd: 0.0001,
        attempts: 1,
      },
      generationId: "gen",
      provider: "Mock",
      servedModel: m.model,
      latencyMs: 3,
    };
  };
  return { call, requests };
}

function rank(
  call: StageCall | null,
  cacheDir: string,
  overrides: Partial<Parameters<typeof runRanking>[0]> = {},
) {
  return runRanking({
    timeline: ferryTimeline,
    packSha256: "a".repeat(64),
    pool: POOL,
    episodes: [1, 2, 3],
    scopeLabel: "test",
    config: CONFIG,
    configHash: "test",
    models: MODELS,
    cacheDir,
    call,
    replicates: 1,
    concurrency: 3,
    runId: "run-1",
    now: () => new Date("2026-11-10T00:00:00Z"),
    ...overrides,
  });
}

describe("a full mocked ranking run", () => {
  const dir = freshDir();
  const first = fakeModel();
  const run = rank(first.call, dir);

  it("produces a complete, validated shortlist and a full order", async () => {
    const { output } = await run;
    expect(output?.status).toBe("complete");
    expect(output?.shortlist.length).toBe(3);
    for (const rec of output?.shortlist ?? [])
      expect(() => recommendationSchema.parse(rec)).not.toThrow();
    expect(output?.list.map((e) => e.candidateId).sort()).toEqual(POOL.map((c) => c.id).sort());
    const statuses = output?.list.map((e) => e.status) ?? [];
    // Finalists first, then other judged clips, then clips screening left out.
    expect(statuses.indexOf("finalist")).toBe(0);
    expect(statuses.lastIndexOf("finalist")).toBeLessThan(statuses.indexOf("not-assessed"));
  });

  it("calls each stage the expected number of times", async () => {
    await run;
    const by = (stage: StageName) => first.requests.filter((r) => r.stage === stage).length;
    expect(by("screen")).toBe(POOL.length);
    // 5 by priority, 1 exploration, plus any episode or moment-type floor.
    expect(by("cold-viewer")).toBe(by("editorial"));
    expect(by("cold-viewer")).toBeGreaterThanOrEqual(6);
    expect(by("pairwise")).toBeGreaterThan(0);
  });

  it("never sends writer notes or source ids to any stage", async () => {
    await run;
    const notes = ferryShow.episodes.flatMap((e) =>
      [e.writerNotes.logline, e.writerNotes.continuityNotes].filter((n): n is string => Boolean(n)),
    );
    for (const r of first.requests) {
      for (const note of notes) expect(r.user + r.system).not.toContain(note);
      expect(r.user).not.toMatch(/E00\d-\d{4}/);
    }
  });

  it("reuses every judgment on a re-run and reproduces the same ranking", async () => {
    const { output } = await run;
    const again = fakeModel();
    const second = await rank(again.call, dir);
    expect(again.requests).toEqual([]);
    expect(second.output).toEqual(output);
    expect(second.stats.every((s) => s.live === 0)).toBe(true);
  });

  it("recomputes scores when the configuration changes, without calling the model", async () => {
    const { output } = await run;
    const again = fakeModel();
    const weights = { hook: 0.6, cliffhanger: 0.1, clarity: 0.1, emotion: 0.1, boundaries: 0.1 };
    const changed = await rank(again.call, dir, { config: { ...CONFIG, weights } });
    expect(again.requests).toEqual([]);
    const score = (o: typeof output, id: string) =>
      o?.list.find((e) => e.candidateId === id)?.editorialScore;
    const judged = output?.list.find((e) => e.editorialScore !== null)?.candidateId ?? "";
    expect(score(changed.output, judged)).not.toBe(score(output, judged));
  });

  it("judges a clip again when its boundaries change, and only that clip", async () => {
    await run;
    const moved = POOL.map((c, i) =>
      i === 0 ? makeCandidate(ferryTimeline, [{ episode: 1, startMs: 1_000, endMs: 25_000 }]) : c,
    );
    const again = fakeModel();
    await rank(again.call, dir, { pool: moved });
    const screens = again.requests.filter((r) => r.stage === "screen");
    expect(screens).toHaveLength(1);
  });

  it("judges everything again for a different model", async () => {
    await run;
    const again = fakeModel();
    await rank(again.call, dir, { models: { ...MODELS, screen: model("mock/other", "screen") } });
    expect(again.requests.filter((r) => r.stage === "screen")).toHaveLength(POOL.length);
    expect(again.requests.filter((r) => r.stage !== "screen")).toEqual([]);
  });

  it("records pairwise metadata, swapped repeats, and stability", async () => {
    const { output, stability, pairs } = await run;
    expect(pairs.some((p) => p.replicate === 1)).toBe(true);
    expect(stability.pairwise.repeatedPairs).toBeGreaterThan(0);
    const top = output?.shortlist[0];
    expect(top?.ranking.pairwise?.comparisons).toBeGreaterThan(0);
  });
});

describe("failures never turn into scores", () => {
  it("leave a failed clip unscored, below every judged clip, and mark the run partial", async () => {
    const dir = freshDir();
    // Only the first pool clip opens on the wide shot. It screens best, so it is assessed.
    const target = POOL[0] as Candidate;
    const top = (user: string) =>
      clipOf(user).includes(OPENS_ON_WIDE_SHOT)
        ? { hook: 4, cliffhanger: 4, clarity: 4, emotion: 4 }
        : {};
    const failing = fakeModel({
      screen: top,
      fail: (stage, user) =>
        stage === "editorial" && clipOf(user).includes(OPENS_ON_WIDE_SHOT)
          ? new InferenceError("schema-invalid", "Completion did not match the schema.", {
              retryable: true,
            })
          : null,
    });
    const { output, assessments } = await rank(failing.call, dir);
    const failed = [...assessments.values()].filter((a) => a.deepStatus === "failed");
    expect(failed.map((a) => a.candidate.id)).toContain(target.id);
    expect(output?.status).toBe("partial");
    expect(output?.notes[0]).toMatch(/Partial run/);
    const entry = output?.list.find((e) => e.candidateId === target.id);
    expect(entry).toMatchObject({ status: "assessment-failed", editorialScore: null });
    expect(output?.shortlist.some((r) => r.candidateId === target.id)).toBe(false);
    const statuses = output?.list.map((e) => e.status) ?? [];
    expect(statuses.indexOf("assessment-failed")).toBeGreaterThan(statuses.lastIndexOf("eligible"));

    // Recovery: the same settings finish the run, sending only what failed.
    const healthy = fakeModel({ screen: top });
    const resumed = await rank(healthy.call, dir);
    expect(resumed.output?.status).toBe("complete");
    expect(healthy.requests.filter((r) => r.stage === "editorial").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(healthy.requests.filter((r) => r.stage === "screen")).toEqual([]);
  });

  it("list clips the provider refused, without scoring them, and still finish", async () => {
    const top = (user: string) =>
      clipOf(user).includes(OPENS_ON_WIDE_SHOT)
        ? { hook: 4, cliffhanger: 4, clarity: 4, emotion: 4 }
        : {};
    const filtered = fakeModel({
      screen: top,
      fail: (stage, user) =>
        stage === "editorial" && clipOf(user).includes(OPENS_ON_WIDE_SHOT)
          ? new InferenceError(
              "content-policy",
              "The provider's content filter withheld the answer.",
            )
          : null,
    });
    const { output } = await rank(filtered.call, freshDir());
    const target = POOL[0] as Candidate;
    expect(output?.status).toBe("complete");
    expect(output?.counts.refusedByProvider).toBe(1);
    expect(output?.notes.join(" ")).toContain(target.id);
    expect(output?.list.find((e) => e.candidateId === target.id)).toMatchObject({
      status: "provider-refused",
      evaluation: "provider-refused",
      manualReview: true,
      editorialScore: null,
      reasons: ["failed:content-policy"],
    });
    expect(output?.incomplete.refusedClips).toEqual([
      expect.objectContaining({
        candidateId: target.id,
        stage: "detailed",
        kind: "content-policy",
      }),
    ]);
    expect(output?.shortlist.some((r) => r.candidateId === target.id)).toBe(false);
    const statuses = output?.list.map((e) => e.status) ?? [];
    expect(statuses.indexOf("provider-refused")).toBeGreaterThan(statuses.lastIndexOf("eligible"));
  });

  it("remember a refusal and do not send that request again unless asked", async () => {
    const dir = freshDir();
    const top = (user: string) =>
      clipOf(user).includes(OPENS_ON_WIDE_SHOT)
        ? { hook: 4, cliffhanger: 4, clarity: 4, emotion: 4 }
        : {};
    const refuse = (stage: StageName, user: string) =>
      stage === "editorial" && clipOf(user).includes(OPENS_ON_WIDE_SHOT)
        ? new InferenceError("content-policy", "The provider's content filter withheld the answer.")
        : null;
    const editorialFor = (m: ReturnType<typeof fakeModel>) =>
      m.requests.filter(
        (r) => r.stage === "editorial" && clipOf(r.user).includes(OPENS_ON_WIDE_SHOT),
      );

    const first = fakeModel({ screen: top, fail: refuse });
    await rank(first.call, dir);
    expect(editorialFor(first).length).toBeGreaterThan(0);

    const second = fakeModel({ screen: top, fail: refuse });
    const again = await rank(second.call, dir);
    expect(editorialFor(second)).toEqual([]);
    expect(again.output?.counts.refusedByProvider).toBe(1);
    expect(again.stats.find((s) => s.stage === "editorial")?.refused).toBe(1);

    const retried = fakeModel({ screen: top });
    const after = await rank(retried.call, dir, { retryRefused: true });
    expect(editorialFor(retried).length).toBeGreaterThan(0);
    expect(after.output?.counts.refusedByProvider).toBe(0);
    expect(after.output?.incomplete.refusedClips).toEqual([]);
  });

  it("do not count a failed attempt as a refusal", async () => {
    const dir = freshDir();
    const broken = fakeModel({
      fail: (stage) =>
        stage === "editorial" ? new InferenceError("malformed-json", "Bad JSON.") : null,
    });
    const first = await rank(broken.call, dir);
    expect(first.output?.status).toBe("partial");
    expect(first.output?.incomplete.refusedClips).toEqual([]);
    expect(first.output?.incomplete.failedClips.length).toBeGreaterThan(0);
    const healthy = fakeModel();
    await rank(healthy.call, dir);
    expect(healthy.requests.some((r) => r.stage === "editorial")).toBe(true);
  });

  it("flag a refused comparison and count the surviving order as half a game", async () => {
    const dir = freshDir();
    let refused = 0;
    const filtered = fakeModel({
      fail: (stage) =>
        stage === "pairwise" && refused++ === 0
          ? new InferenceError(
              "content-policy",
              "The provider's content filter withheld the answer.",
            )
          : null,
    });
    const { output } = await rank(filtered.call, dir, {
      config: { ...CONFIG, pairwise: { ...CONFIG.pairwise, repeatShare: 1 } },
    });
    expect(output?.status).toBe("complete");
    expect(output?.incomplete.refusedComparisons).toHaveLength(1);
    expect(output?.counts.comparisonsRefused).toBe(1);
    const [pair] = output?.incomplete.refusedComparisons ?? [];
    const affected = output?.shortlist.filter(
      (r) => r.candidateId === pair?.first || r.candidateId === pair?.second,
    );
    for (const rec of affected ?? []) {
      expect(rec.ranking.pairwise?.refused).toBe(1);
      expect(rec.editorReview).toContain("comparison-refused:1");
    }
  });

  it("stop at the budget instead of inventing judgments", async () => {
    const guard = new SpendGuard({ maxCostUsd: 0.05, maxRequests: 1_000 });
    const capped = fakeModel({ guard });
    const call: StageCall = async (stage, m, request, hooks) => {
      if (guard.spentUsd + 0.01 > guard.maxCostUsd) {
        throw new InferenceError("budget", "Budget would be exceeded.");
      }
      return capped.call(stage, m, request, hooks);
    };
    const { output, stats } = await rank(call, freshDir());
    expect(output?.status).toBe("partial");
    expect(stats.reduce((n, s) => n + s.skipped, 0)).toBeGreaterThan(0);
    for (const entry of output?.list ?? []) {
      if (entry.status === "not-assessed" || entry.status === "assessment-failed") {
        expect(entry.editorialScore).toBeNull();
      }
    }
  });

  it("stop sending after a fatal error", async () => {
    const fatal = fakeModel({ fail: () => new InferenceError("auth", "Invalid key.") });
    const result = await rank(fatal.call, freshDir(), { concurrency: 1 });
    expect(result.fatal?.kind).toBe("auth");
    expect(fatal.requests).toHaveLength(1);
    expect(result.output?.status).toBe("partial");
  });
});

describe("rank-3 outputs", () => {
  it("judge every pair in both orders by default, reusing a cached order", async () => {
    const dir = freshDir();
    const partial = { ...CONFIG, pairwise: { ...CONFIG.pairwise, repeatShare: 0 } };
    const first = fakeModel();
    const one = await rank(first.call, dir, { config: partial });
    const onePairs = first.requests.filter((r) => r.stage === "pairwise").length;
    expect(one.stability.pairwise.repeatedPairs).toBe(0);

    const balanced = { ...CONFIG, pairwise: { ...CONFIG.pairwise, repeatShare: 1 } };
    const second = fakeModel();
    const two = await rank(second.call, dir, { config: balanced });
    expect(second.requests.filter((r) => r.stage === "pairwise")).toHaveLength(onePairs);
    expect(second.requests.filter((r) => r.stage !== "pairwise")).toEqual([]);
    expect(two.stability.pairwise.repeatedPairs).toBe(onePairs);
    expect(two.output?.positionBias.repeatedPairs).toBe(onePairs);
  });

  it("export every eligible clip with full detail, marking the shortlist", async () => {
    const { output, promos } = await rank(fakeModel().call, freshDir());
    const eligible = output?.list.filter((e) => e.status === "finalist" || e.status === "eligible");
    expect(promos?.promos.map((p) => p.promo.candidateId)).toEqual(
      eligible?.map((e) => e.candidateId),
    );
    for (const { promo } of promos?.promos ?? []) {
      expect(promo.segments.length).toBeGreaterThan(0);
      expect(promo.hook.explanation.length).toBeGreaterThan(0);
      expect(promo.whyItWorks.length).toBeGreaterThan(0);
    }
    const onList = promos?.promos.filter((p) => p.shortlistRank !== null).length;
    expect(onList).toBe(output?.shortlist.length);
    expect(promos?.promos.every((p, i) => p.promo.rank === i + 1)).toBe(true);
  });

  it("set aside a clip that retells a stronger clip's story in another episode", async () => {
    // Only the first clip in episode 1 and one clip in episode 2 are described alike.
    const dir = freshDir();
    const describe = (user: string) => {
      const clip = clipOf(user);
      const incident = clip.includes(OPENS_ON_WIDE_SHOT)
        ? "A flare gun presses against Mara's temple on the burning pier."
        : clip.includes(EPISODE_TWO_LINE)
          ? "On the burning pier a flare gun is pressed to Mara's temple."
          : `A quiet exchange about the ${"cargo manifest tide schedule lantern oil".split(" ")[user.length % 5]} follows.`;
      return {
        hook: { ...fakeEditorial(user).hook, opening: incident },
        cliffhanger: { ...fakeEditorial(user).cliffhanger, ending: incident },
      };
    };
    const repeats = fakeModel({
      screen: (user) => ({
        hook: 4,
        cliffhanger: 4,
        clarity: 4,
        emotion: 4,
        note: user.slice(0, 1),
      }),
      editorial: describe,
    });
    const wide = {
      ...CONFIG,
      screening: { ...CONFIG.screening, shortlist: 8 },
      pairwise: { ...CONFIG.pairwise, finalists: 8 },
      diversity: { ...CONFIG.diversity, top: 8 },
    };
    const { output } = await rank(repeats.call, dir, { config: wide });
    const narrativeRepeats = output?.alternates.filter((a) => a.basis === "narrative") ?? [];
    expect(narrativeRepeats.length).toBeGreaterThan(0);
    const picked = new Set(output?.shortlist.map((r) => r.candidateId));
    const finalists = new Set(
      output?.list.filter((e) => e.status === "finalist").map((e) => e.candidateId),
    );
    for (const alt of narrativeRepeats) {
      expect(picked.has(alt.candidateId)).toBe(false);
      expect(picked.has(alt.redundantWith)).toBe(true);
    }
    // Head-to-head still compares such clips: only the shortlist treats them as repeats.
    expect(narrativeRepeats.some((alt) => finalists.has(alt.candidateId))).toBe(true);
  });
});

describe("boundary corrections are judged from scratch", () => {
  it("evaluate the corrected clip on its own opening and keep the original's scores", async () => {
    const dir = freshDir();
    // Every clip that opens on the ferry wide shot proposes starting on its second event.
    const proposing = fakeModel({
      screen: (user) =>
        clipOf(user).includes(OPENS_ON_WIDE_SHOT)
          ? { hook: 4, cliffhanger: 4, clarity: 4, emotion: 4 }
          : {},
      editorial: (user) =>
        clipOf(user).includes(OPENS_ON_WIDE_SHOT)
          ? {
              correction: {
                propose: true,
                startRef: "C3",
                endRef: "",
                reason: "Open on the line.",
              },
            }
          : {},
    });
    const { assessments, output } = await rank(proposing.call, dir);
    const derived = [...assessments.values()].filter((a) => a.derived);
    expect(derived).toHaveLength(1);
    const corrected = derived[0];
    const original = assessments.get(corrected?.derived?.from ?? "");
    expect(original?.correction).toMatchObject({
      status: "valid",
      derivedId: corrected?.candidate.id,
    });
    expect(corrected?.candidate.segments[0]?.startMs).not.toBe(
      original?.candidate.segments[0]?.startMs,
    );
    expect(corrected?.scored).not.toBeNull();
    // The corrected clip (4.5 to 25.0 s) is judged on its own opening, not the original's.
    expect(corrected?.candidate.segments[0]).toMatchObject({ startMs: 4_500, endMs: 25_000 });
    const own = proposing.requests.filter(
      (r) => r.stage === "cold-viewer" && r.user.includes("Clip length: 20.5 seconds"),
    );
    expect(own).toHaveLength(1);
    expect(own[0]?.user).not.toContain(OPENS_ON_WIDE_SHOT);
    expect(original?.scored?.score).toBeDefined();
    expect(output?.list.find((e) => e.candidateId === corrected?.candidate.id)?.derivedFrom).toBe(
      original?.candidate.id,
    );
  });
});

describe("plans and stability measures", () => {
  it("make no calls in a plan", async () => {
    const result = await rank(null, freshDir());
    expect(result.output).toBeNull();
    expect(result.plan).toEqual({ screenCalls: POOL.length, passing: POOL.length });
  });

  it("measure repeat and second-judge agreement", async () => {
    const twice = fakeModel();
    const result = await rank(twice.call, freshDir(), {
      replicates: 2,
      models: {
        ...MODELS,
        secondJudge: {
          "cold-viewer": model("mock/second", "cold-viewer"),
          editorial: model("mock/second", "editorial"),
        },
      },
    });
    expect(result.stability.replicate?.candidates).toBeGreaterThan(0);
    // The fake model answers identically each time, so agreement is perfect.
    expect(result.stability.replicate?.exact.hook).toBe(1);
    expect(result.stability.secondJudge?.gateAgreement).toBe(1);
    expect(twice.requests.some((r) => r.model === "mock/second")).toBe(true);
  });

  it("writes only validated judgments to the cache", async () => {
    const dir = freshDir();
    const broken = fakeModel({
      fail: (stage) =>
        stage === "cold-viewer" ? new InferenceError("malformed-json", "Bad JSON.") : null,
    });
    await rank(broken.call, dir);
    const files = readdirSync(dir);
    expect(files.length).toBe(broken.requests.filter((r) => r.stage !== "cold-viewer").length);
  });
});
