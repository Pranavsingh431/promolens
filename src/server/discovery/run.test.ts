import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NIGHT_FERRY } from "../../../tests/support/fixtures";
import { buildDiscoveryPrompt } from "../../domain/discovery/prompts/discovery-v1";
import type { ProposalResponse } from "../../domain/discovery/proposal";
import { assembleShow } from "../../domain/screenplay/assemble-show";
import { parseEpisode } from "../../domain/screenplay/parse-episode";
import type { Show } from "../../domain/screenplay/schema";
import { createTimeline } from "../../domain/screenplay/timeline";
import { InferenceError } from "../inference/errors";
import type { JsonCompletion } from "../inference/openrouter";
import { cacheKey, readCache } from "./cache";
import {
  cacheKeyParts,
  runDiscovery,
  summarizeRuns,
  type Complete,
  type DiscoveryConfig,
} from "./run";

const show = assembleShow(
  "night-ferry",
  NIGHT_FERRY.map(({ name, text }) => parseEpisode({ path: `night-ferry/${name}`, text })),
).show as Show;
const timeline = createTimeline(show);
const CONFIG: DiscoveryConfig = {
  model: "vendor/model",
  variant: "writer-context",
  maxTokens: 4_000,
  reasoningEffort: "low",
  privacy: "strict-zdr",
};

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const cacheDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "promolens-cache-"));
  dirs.push(dir);
  return dir;
};

/** A plausible answer for each fixture episode, written by hand for these tests. */
const ANSWERS: Record<number, ProposalResponse> = {
  1: {
    episodeNotes: "Two strong moments.",
    proposals: [
      {
        startEvent: 3,
        endEvent: 15,
        hookEvents: [4],
        cliffhangerEvents: [15],
        supportingEvents: [],
        hookType: "curiosity",
        hook: "h",
        cliffhanger: "c",
        whyItWorks: "w",
        contextNeeded: [],
        warnings: [],
      },
      {
        startEvent: 99,
        endEvent: 15,
        hookEvents: [4],
        cliffhangerEvents: [15],
        supportingEvents: [],
        hookType: "reveal",
        hook: "h",
        cliffhanger: "c",
        whyItWorks: "w",
        contextNeeded: [],
        warnings: [],
      },
    ],
  },
  2: {
    episodeNotes: "One moment.",
    proposals: [
      {
        startEvent: 1,
        endEvent: 6,
        hookEvents: [2],
        cliffhangerEvents: [6],
        supportingEvents: [],
        hookType: "confrontation",
        hook: "h",
        cliffhanger: "c",
        whyItWorks: "w",
        contextNeeded: [],
        warnings: ["needs-earlier-context"],
      },
    ],
  },
  3: { episodeNotes: "Too short for a promo.", proposals: [] },
};

const episodeOf = (prompt: { user: string }) => Number(/^Episode (\d+)/.exec(prompt.user)?.[1]);

function completion(value: ProposalResponse): JsonCompletion<ProposalResponse> {
  return {
    value,
    spend: {
      usage: { inputTokens: 1_000, outputTokens: 400, reasoningTokens: 100, cachedTokens: 0 },
      billedUsd: 0.0003,
      estimatedUsd: 0.0003,
      attempts: 1,
    },
    generationId: "gen-x",
    provider: "Vendor",
    servedModel: "vendor/model",
    latencyMs: 1_200,
  };
}

function fake(
  behaviour: (episode: number, call: number) => ProposalResponse | InferenceError = (e) =>
    ANSWERS[e] as ProposalResponse,
) {
  const calls: number[] = [];
  let active = 0;
  let peak = 0;
  const complete: Complete = async (prompt) => {
    const episode = episodeOf(prompt);
    calls.push(episode);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    const result = behaviour(episode, calls.filter((e) => e === episode).length);
    if (result instanceof InferenceError) throw result;
    return completion(result);
  };
  return { complete, calls, peak: () => peak };
}

const run = (
  dir: string,
  complete: Complete | undefined,
  extra: Partial<Parameters<typeof runDiscovery>[0]> = {},
) =>
  runDiscovery({
    show,
    timeline,
    episodes: [1, 2, 3],
    config: CONFIG,
    cacheDir: dir,
    dryRun: false,
    fresh: false,
    concurrency: 2,
    ...(complete ? { complete } : {}),
    ...extra,
  });

describe("runDiscovery", () => {
  it("processes every episode, keeps provenance, and records accounting", async () => {
    const dir = cacheDir();
    const model = fake();
    const result = await run(dir, model.complete);
    expect(result.runs.map((r) => [r.episode, r.status, r.proposals, r.accepted])).toEqual([
      [1, "succeeded", 2, 1],
      [2, "succeeded", 1, 1],
      [3, "succeeded", 0, 0],
    ]);
    expect(result.runs[0]).toMatchObject({
      rejected: { "unknown-anchor": 1 },
      unknownRefs: 1,
      proposalsWithUnknownRefs: 1,
      billedUsd: 0.0003,
    });
    expect(result.candidates.map((c) => [c.rank, c.method, c.segments[0]?.episode])).toEqual([
      [1, "ai-writer-context", 1],
      [2, "ai-writer-context", 2],
    ]);
    expect(result.candidates[0]?.methodVersion).toContain("vendor/model");
    expect(result.candidates[1]?.cues).toContain("warn:needs-earlier-context");
    expect(model.peak()).toBeLessThanOrEqual(2);

    const totals = summarizeRuns(result.runs);
    expect(totals).toMatchObject({
      processed: 3,
      withCandidates: 2,
      proposals: 3,
      accepted: 2,
      cacheHits: 0,
    });
    expect(readdirSync(dir)).toHaveLength(3);
  });

  it("resumes from the cache and only retries episodes that failed", async () => {
    const dir = cacheDir();
    const flaky = fake((episode, call) =>
      episode === 2 && call === 1
        ? new InferenceError("provider", "Gave up after 3 attempts.", { retryable: true })
        : (ANSWERS[episode] as ProposalResponse),
    );
    const first = await run(dir, flaky.complete);
    expect(first.runs.map((r) => r.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(first.runs[1]?.error).toEqual({
      kind: "provider",
      message: "Gave up after 3 attempts.",
    });
    expect(readdirSync(dir)).toHaveLength(2);

    const second = await run(dir, flaky.complete);
    expect(second.runs.map((r) => r.status)).toEqual(["cached", "succeeded", "cached"]);
    expect(flaky.calls).toEqual([1, 2, 3, 2]);
    expect(second.candidates).toEqual((await run(dir, flaky.complete)).candidates);
  });

  it("does not reuse results after the model, prompt settings, or episode text change", async () => {
    const dir = cacheDir();
    const model = fake();
    await run(dir, model.complete, { episodes: [1] });
    await run(dir, model.complete, { episodes: [1], config: { ...CONFIG, model: "vendor/other" } });
    await run(dir, model.complete, { episodes: [1], config: { ...CONFIG, maxTokens: 5_000 } });
    await run(dir, model.complete, {
      episodes: [1],
      config: { ...CONFIG, variant: "screen-only" },
    });
    const edited: Show = {
      ...show,
      episodes: show.episodes.map((e) =>
        e.number === 1
          ? { ...e, events: e.events.map((v, i) => (i === 0 ? { ...v, text: "Changed." } : v)) }
          : e,
      ),
    };
    await run(dir, model.complete, {
      episodes: [1],
      show: edited,
      timeline: createTimeline(edited),
    });
    await run(dir, model.complete, { episodes: [1] });
    expect(model.calls).toEqual([1, 1, 1, 1, 1]);
  });

  it("ignores cache entries older than a resumed fresh run, but keeps that run's own results", async () => {
    const dir = cacheDir();
    const model = fake();
    await run(dir, model.complete, { episodes: [1, 2] });
    const boundary = new Date(Date.now() + 1).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await run(dir, model.complete, { episodes: [3] });
    const resumed = await run(dir, model.complete, { cacheNotBefore: boundary });
    expect(resumed.runs.map((r) => r.status)).toEqual(["succeeded", "succeeded", "cached"]);
    // Episodes in one run start concurrently, so only the order between runs is meaningful.
    const sorted = (calls: number[]) => [...calls].sort((a, b) => a - b);
    expect(sorted(model.calls.slice(0, 2))).toEqual([1, 2]);
    expect(model.calls[2]).toBe(3);
    expect(sorted(model.calls.slice(3))).toEqual([1, 2]);
  });

  it("treats a damaged cache file as a miss and replaces it", async () => {
    const dir = cacheDir();
    const model = fake();
    await run(dir, model.complete, { episodes: [1] });
    const [file] = readdirSync(dir);
    const entry = JSON.parse(readFileSync(join(dir, file as string), "utf8"));
    entry.response.proposals[0].startEvent = "tampered";
    writeFileSync(join(dir, file as string), JSON.stringify(entry));
    const again = await run(dir, model.complete, { episodes: [1] });
    expect(again.runs[0]).toMatchObject({ status: "succeeded", cacheCorrupt: true });
    expect(model.calls).toEqual([1, 1]);
  });

  it("skips episodes once the budget is spent, without marking them done", async () => {
    const dir = cacheDir();
    const model = fake((episode) =>
      episode === 1
        ? (ANSWERS[1] as ProposalResponse)
        : new InferenceError("budget", "Budget of $0.01 would be exceeded."),
    );
    const result = await run(dir, model.complete, { concurrency: 1 });
    expect(result.runs.map((r) => r.status)).toEqual(["succeeded", "skipped", "skipped"]);
    expect(summarizeRuns(result.runs)).toMatchObject({ processed: 1, withCandidates: 1 });
  });

  it("stops calling after an error that affects every request", async () => {
    const model = fake(() => new InferenceError("auth", "HTTP 401: bad key", { status: 401 }));
    const result = await run(cacheDir(), model.complete, { concurrency: 1 });
    expect(result.runs.map((r) => [r.status, r.error?.kind])).toEqual([
      ["failed", "auth"],
      ["skipped", "stopped"],
      ["skipped", "stopped"],
    ]);
    expect(model.calls).toEqual([1]);
  });

  it("makes no calls in a dry run but still reports cached episodes", async () => {
    const dir = cacheDir();
    await run(dir, fake().complete, { episodes: [2] });
    const dry = await run(dir, undefined, { dryRun: true, estimateUsd: () => 0.01 });
    expect(dry.runs.map((r) => [r.status, r.estimatedUsd])).toEqual([
      ["planned", 0.01],
      ["cached", 0],
      ["planned", 0.01],
    ]);
  });

  it("only caches responses that passed validation", async () => {
    const dir = cacheDir();
    const failing = fake(
      () => new InferenceError("schema-invalid", "Gave up after 3 attempts.", { retryable: true }),
    );
    await run(dir, failing.complete, { episodes: [1] });
    const episode = show.episodes[0]!;
    const parts = cacheKeyParts(episode, CONFIG, buildDiscoveryPrompt(episode, CONFIG.variant));
    expect(await readCache(dir, parts)).toEqual({ status: "miss" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("changes the cache key when any input that shapes the answer changes", () => {
    const episode = show.episodes[0]!;
    const base = cacheKeyParts(episode, CONFIG, buildDiscoveryPrompt(episode, CONFIG.variant));
    const variants: Array<Partial<typeof base>> = [
      { episodeFingerprint: "0".repeat(64) },
      { promptSha256: "1".repeat(64) },
      { jsonSchemaSha256: "2".repeat(64) },
      { promptVersion: "discovery-v2" },
      { schemaVersion: "proposals-2" },
      { variant: "screen-only" },
      { model: "vendor/other" },
      { maxTokens: 1 },
      { reasoningEffort: "high" },
      { privacy: "allow-safety-retention" },
    ];
    const keys = new Set([cacheKey(base), ...variants.map((v) => cacheKey({ ...base, ...v }))]);
    expect(keys.size).toBe(variants.length + 1);
    expect(cacheKey({ ...base })).toBe(cacheKey(base));
  });
});
