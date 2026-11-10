import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  readStageCache,
  readStageRefusal,
  stageCacheKey,
  writeStageCache,
  writeStageRefusal,
  type StageKeyParts,
} from "./cache";
import { readLedger, recordRun, spentSoFar } from "./ledger";

const root = mkdtempSync(join(tmpdir(), "promolens-rank-cache-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const parts: StageKeyParts = {
  stage: "editorial",
  promptVersion: "editorial-v1",
  rubricVersion: "1.0",
  subjectSha256: "a".repeat(64),
  promptSha256: "b".repeat(64),
  jsonSchemaSha256: "c".repeat(64),
  model: "mock/judge",
  maxTokens: 8_000,
  reasoningEffort: "low",
  privacy: "strict-zdr",
  replicate: 0,
};
const meta = {
  generationId: "g",
  provider: "Mock",
  servedModel: "mock/judge",
  attempts: 1,
  latencyMs: 10,
  billedUsd: 0.0002,
  estimatedUsd: 0.0002,
  usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0 },
};
const parse = (v: unknown) => z.object({ ok: z.boolean() }).parse(v);

describe("the ranking cache", () => {
  it("returns a stored judgment for the same key", async () => {
    await writeStageCache(root, parts, { ok: true }, meta);
    expect(await readStageCache(root, parts, parse)).toMatchObject({
      status: "hit",
      response: { ok: true },
    });
  });

  it("misses when anything that shapes the answer changes", async () => {
    for (const change of [
      { subjectSha256: "d".repeat(64) },
      { promptSha256: "e".repeat(64) },
      { jsonSchemaSha256: "f".repeat(64) },
      { model: "mock/other" },
      { replicate: 1 },
      { rubricVersion: "2.0" },
      { reasoningEffort: "high" },
    ]) {
      const other = { ...parts, ...change };
      expect(stageCacheKey(other)).not.toBe(stageCacheKey(parts));
      expect((await readStageCache(root, other, parse)).status).toBe("miss");
    }
  });

  it("reports damaged or tampered entries instead of trusting them", async () => {
    const tampered = { ...parts, subjectSha256: "9".repeat(64) };
    const key = await writeStageCache(root, tampered, { ok: true }, meta);
    const path = join(root, `${key}.json`);
    const entry = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...entry, parts: { ...entry.parts, model: "x" } }));
    expect((await readStageCache(root, tampered, parse)).status).toBe("corrupt");
    writeFileSync(path, "{not json");
    expect((await readStageCache(root, tampered, parse)).status).toBe("corrupt");
  });

  it("treats an entry that no longer passes validation as damaged", async () => {
    const stale = { ...parts, subjectSha256: "8".repeat(64) };
    await writeStageCache(root, stale, { ok: "yes" }, meta);
    expect(await readStageCache(root, stale, parse)).toMatchObject({ status: "corrupt" });
  });
});

describe("recorded refusals", () => {
  it("are found again for the same request and only for that request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "promolens-refusal-"));
    try {
      expect(await readStageRefusal(dir, parts)).toBeNull();
      await writeStageRefusal(dir, parts, "content-policy", "2026-11-10T00:00:00.000Z");
      expect(await readStageRefusal(dir, parts)).toMatchObject({ kind: "content-policy" });
      expect(await readStageRefusal(dir, { ...parts, model: "mock/other" })).toBeNull();
      expect((await readStageCache(dir, parts, parse)).status).toBe("miss");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treat a damaged record as no record, so the request is sent normally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "promolens-refusal-"));
    try {
      await writeStageRefusal(dir, parts, "refusal");
      const file = readdirSync(dir)[0] as string;
      writeFileSync(join(dir, file), "not json");
      expect(await readStageRefusal(dir, parts)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the experiment ledger", () => {
  const path = join(root, "ledger.json");

  it("adds up spending across runs and replaces a run's running estimate", async () => {
    let ledger = await readLedger(path, { experiment: "x", budgetUsd: 2 });
    const run = (id: string, spent: number, status: "running" | "finished") => ({
      runId: id,
      startedAt: "2026-11-10T00:00:00Z",
      finishedAt: status === "finished" ? "2026-11-10T00:01:00Z" : null,
      spentUsd: spent,
      billedUsd: status === "finished" ? spent : null,
      requests: 3,
      status,
    });
    ledger = await recordRun(path, ledger, run("one", 0.3, "finished"));
    ledger = await recordRun(path, ledger, run("two", 0.5, "running"));
    expect(spentSoFar(ledger)).toBeCloseTo(0.8, 9);
    ledger = await recordRun(path, ledger, run("two", 0.2, "finished"));
    expect(spentSoFar(await readLedger(path, { experiment: "x", budgetUsd: 2 }))).toBeCloseTo(
      0.5,
      9,
    );
  });

  it("refuses to continue from a damaged ledger", async () => {
    writeFileSync(path, JSON.stringify({ experiment: "x", budgetUsd: -1, runs: [] }));
    await expect(readLedger(path, { experiment: "x", budgetUsd: 2 })).rejects.toThrow(/damaged/);
  });
});
