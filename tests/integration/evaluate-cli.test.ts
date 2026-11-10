import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { NIGHT_FERRY } from "../support/fixtures";
import { buildZip } from "../support/zip-builder";

const CLI = fileURLToPath(new URL("../../scripts/evaluate.ts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "promolens-eval-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const pack = join(root, "ferry.zip");
writeFileSync(
  pack,
  buildZip(NIGHT_FERRY.map(({ name, text }) => ({ name: `night-ferry/${name}`, data: text }))),
);
const dir = join(root, "workspace");

function run(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, ...args, "--dir", dir],
    {
      encoding: "utf8",
    },
  );
  return { code: result.status, out: result.stdout + result.stderr };
}
const read = (path: string) => readFileSync(join(dir, path), "utf8");

// These tests start real CLI processes, several per test. Under a full parallel run that
// can pass the 5 s default, so they get a limit suited to process startup.
describe("evaluation commands on a synthetic pack", { timeout: 30_000 }, () => {
  it("draw a sample once and refuse to redraw the held-out set", () => {
    expect(run("sample", pack).code).toBe(0);
    const first = read("sample.json");
    const again = run("sample", pack);
    expect(again.code).toBe(1);
    expect(again.out).toContain("held-out set must stay fixed");
    expect(read("sample.json")).toBe(first);
  });

  it("generate the same baseline files byte for byte on every run", () => {
    expect(run("candidates", pack).code).toBe(0);
    const uniform = read("candidates/uniform.json");
    const cues = read("candidates/cues.json");
    expect(run("candidates", pack).code).toBe(0);
    expect(read("candidates/uniform.json")).toBe(uniform);
    expect(read("candidates/cues.json")).toBe(cues);
  });

  it("prepare blind review items whose file never names a method", () => {
    const result = run("prepare-review", pack);
    expect(result.code).toBe(0);
    expect(read("review/items.json")).not.toMatch(/uniform|cues/);
    expect(read("review/key.json")).toMatch(/uniform|cues/);
  });

  it("report that human review has not started and keep editorial metrics unavailable", () => {
    expect(run("validate", pack).out).toContain("Human review has not started.");
    expect(run("metrics", pack).out).toContain("editorial metrics unavailable");
    const report = JSON.parse(read("reports/metrics-development.json"));
    expect(report.annotations.status).toBe("awaiting-review");
    expect(report.methods.every((m: { editorial: unknown }) => m.editorial === null)).toBe(true);
  });

  it("validate and score a test annotation file, and log held-out runs", () => {
    const items = JSON.parse(read("review/items.json")).items as Array<{
      itemId: string;
      clipKey: string;
    }>;
    const sample = JSON.parse(read("sample.json"));
    const rating = {
      ratings: { hook: 3, cliffhanger: 3, clarity: 3, emotion: 2, boundaries: 3 },
      decision: "keep",
      mainReason: "strong-cliffhanger",
      weaknesses: [],
      notes: "",
    };
    // A synthetic reviewer, written by this test. It is not a human judgment of real data.
    mkdirSync(join(dir, "annotations"), { recursive: true });
    writeFileSync(
      join(dir, "annotations", "TEST.json"),
      JSON.stringify({
        schemaVersion: 1,
        rubricVersion: "1.0",
        reviewer: "TEST",
        sampleVersion: sample.version,
        revision: 1,
        partA: [],
        partB: items.map((item) => ({
          ...item,
          judgment: rating,
          version: 1,
          updatedAt: "2026-11-10T10:00:00.000Z",
        })),
      }),
    );
    expect(run("validate", pack)).toMatchObject({ code: 0 });
    expect(run("metrics", pack, "--split", "all").code).toBe(0);
    const report = JSON.parse(read("reports/metrics-all.json"));
    expect(report.annotations.status).toBe("partial");
    expect(report.methods[0].editorial.macro.precisionAtK.value).toBe(1);

    expect(existsSync(join(dir, "reports", "held-out-runs.log"))).toBe(false);
    const heldOut = run("report", pack, "--split", "held-out");
    expect(heldOut.code).toBe(0);
    expect(heldOut.out).toContain("do not tune");
    expect(read("reports/held-out-runs.log")).toMatch(/report\n$/);
    expect(read("reports/comparison-held-out.md")).toContain("# Baseline comparison (held-out)");
    expect(report.methods[0].list.precisionAtK).toBe(1);
    expect(read("reports/comparison-held-out.md")).toContain("judged-only");
  });

  it("append review items for a new round without touching rated items", () => {
    const before = JSON.parse(read("review/items.json")).items as Array<{ itemId: string }>;
    // Ratings exist now, so a plain rebuild is refused.
    expect(run("prepare-review", pack).code).toBe(1);
    // A stand-in for a ranking set: the cue baseline under another method name.
    const cues = JSON.parse(read("candidates/cues.json"));
    const ranked = {
      ...cues,
      method: "ranked",
      candidates: cues.candidates.map((c: { clipKey: string }) => ({
        ...c,
        id: `ranked:${c.clipKey}`,
        method: "ranked",
      })),
    };
    writeFileSync(join(dir, "candidates", "ranked.json"), JSON.stringify(ranked));
    const result = run(
      "prepare-review",
      pack,
      "--append",
      "--split",
      "development",
      "--per-method",
      "4",
      "--controls",
      "1",
    );
    expect(result.code, result.out).toBe(0);
    const after = JSON.parse(read("review/items.json")).items as Array<{ itemId: string }>;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(read("review/items.json")).not.toMatch(/ranked|control/);
    expect(run("validate", pack).code).toBe(0);
  });

  it("reject bad arguments", () => {
    expect(run("unknown", pack).code).toBe(2);
    expect(run("metrics", pack, "--split", "test").code).toBe(2);
    expect(run("metrics", pack, "--k", "0").code).toBe(2);
  });
});
