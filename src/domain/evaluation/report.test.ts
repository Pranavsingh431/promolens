import { describe, expect, it } from "vitest";

import { syntheticShow } from "../../../tests/support/synthetic-show";
import { createTimeline } from "../screenplay/timeline";
import { emptyAnnotationFile, type AnnotationFile, type JudgmentRecord } from "./annotation";
import { generateCueBased, generateUniform } from "./baselines";
import { DEFAULT_METRIC_OPTIONS } from "./metrics";
import { buildEvaluationReport, renderReportMarkdown, shortlistCheck } from "./report";
import { judgmentSchema } from "./rubric";
import { selectSample } from "./sample";

const show = syntheticShow({ episodes: 12, seed: 4 });
const timeline = createTimeline(show);
const sample = selectSample(show, "c".repeat(64));
const sets = [generateUniform(timeline), generateCueBased(timeline)].map((s) => ({
  ...s,
  packSha256: "c".repeat(64),
}));
const base = { sample, sets, timeline, options: DEFAULT_METRIC_OPTIONS };

describe("buildEvaluationReport", () => {
  it("reports structural metrics and marks editorial metrics unavailable without human labels", () => {
    const report = buildEvaluationReport({ ...base, split: "development", files: [] });
    expect(report.annotations.status).toBe("awaiting-review");
    expect(report.methods.every((m) => m.editorial === null)).toBe(true);
    expect(
      report.methods.every((m) => m.structural.candidates > 0 && m.structural.validityRate === 1),
    ).toBe(true);
    expect(report.agreement).toBeNull();
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain("Unavailable: no human judgments yet.");
    expect(markdown).not.toMatch(/Precision@3 \| [0-9]/);
  });

  it("uses only judgments from episodes in the requested split", () => {
    const heldOutEpisode = sample.episodes.find((e) => e.split === "held-out")?.episode ?? 0;
    const candidate = sets[0]!.candidates.find((c) => c.segments[0]?.episode === heldOutEpisode)!;
    const judged: AnnotationFile = {
      ...emptyAnnotationFile("R1", sample.version),
      partB: [
        {
          itemId: "B001",
          clipKey: candidate.clipKey,
          judgment: judgmentSchema.parse({
            ratings: { hook: 3, cliffhanger: 3, clarity: 3, emotion: 3, boundaries: 3 },
            decision: "keep",
            mainReason: "all-round",
            weaknesses: [],
            notes: "",
          }),
          version: 1,
          updatedAt: "2026-11-10T10:00:00.000Z",
        },
      ],
    };
    expect(
      buildEvaluationReport({ ...base, split: "development", files: [judged] }).annotations.status,
    ).toBe("awaiting-review");
    const heldOut = buildEvaluationReport({ ...base, split: "held-out", files: [judged] });
    expect(heldOut.annotations).toMatchObject({ status: "partial", partBReviews: 1 });
    expect(heldOut.notes).toContain(
      "Held-out results are for final checks only. Do not tune methods on them.",
    );
    const uniform = heldOut.methods.find((m) => m.method === "uniform")?.editorial;
    expect(uniform?.macro.precisionAtK).toEqual({ value: 1, episodes: 1 });
  });
});

describe("the shortlist check", () => {
  const judgment = (decision: "keep" | "reject") =>
    ({
      decision,
      ratings: { hook: 3, cliffhanger: 3, clarity: 3, emotion: 3, boundaries: 3 },
    }) as JudgmentRecord["judgment"];
  const record = (clipKey: string, decision: "keep" | "reject"): JudgmentRecord => ({
    reviewer: "R1",
    source: "part-b",
    clipKey,
    segments: [{ episode: 1, startMs: 0, endMs: 25_000 }],
    judgment: judgment(decision),
  });
  const entry = (clipKey: string, role: "shortlist" | "shortlist-control") => ({
    itemId: "B001",
    clipKey,
    candidates: [{ id: clipKey, method: "ranked", methodVersion: "v", rank: 1, role }],
  });
  const key = {
    entries: [entry("a", "shortlist"), entry("b", "shortlist"), entry("c", "shortlist-control")],
  };

  it("counts only clips a person rated, so an unrated clip is never a rejection", () => {
    const check = shortlistCheck([record("a", "keep")], key);
    expect(check).toEqual([
      { role: "shortlist", items: 2, rated: 1, kept: 1, meanGain: expect.any(Number) },
      { role: "shortlist-control", items: 1, rated: 0, kept: 0, meanGain: null },
    ]);
  });

  it("is absent when the round has no shortlist items", () => {
    expect(shortlistCheck([], { entries: [] })).toBeNull();
  });
});
