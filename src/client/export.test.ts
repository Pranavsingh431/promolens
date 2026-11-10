import { describe, expect, it } from "vitest";

import { promoExportSchema, rankingOutputSchema } from "@/domain/ranking/output";
import { buildDemoResults } from "@/demo/results";

import { buildExportFile } from "./export";

const results = buildDemoResults("complete");

describe("export files", () => {
  it("writes one CSV row per promo with exact ordered segments and rationale", () => {
    const file = buildExportFile(results, "promos-csv");
    expect(file.fileName).toBe("promolens-demo-night-ferry-promos.csv");
    expect(file.mimeType).toContain("text/csv");
    const lines = file.content.trim().split("\r\n");
    expect(lines).toHaveLength(results.promos.promos.length + 1);
    expect(lines[0]).toContain("rank,shortlist_rank,alternate_of,segments,duration_s");
    expect(file.content).toContain("E001 00:05.00 to 00:31.00");
    expect(file.content).toContain("E001 00:49.50 to 01:02.40 + E003 00:49.40 to 01:01.00");
    expect(file.content).toContain("clarity-at-the-minimum");
  });

  it("writes promos JSON that still matches the rank-3 contract, unchanged", () => {
    const file = buildExportFile(results, "promos-json");
    const parsed = promoExportSchema.parse(JSON.parse(file.content));
    expect(parsed).toEqual(results.promos);
  });

  it("writes the full report with model details and evaluation states", () => {
    const file = buildExportFile(results, "ranking-json");
    const parsed = rankingOutputSchema.parse(JSON.parse(file.content));
    expect(parsed.versions.ranking).toBe("rank-3");
    expect(parsed.list.map((entry) => entry.evaluation)).toContain("provider-refused");
    expect(parsed.incomplete.refusedClips).toHaveLength(1);
  });

  it("says a partial run is partial in the file name", () => {
    const file = buildExportFile(buildDemoResults("partial"), "promos-csv");
    expect(file.fileName).toBe("promolens-demo-night-ferry-partial-promos.csv");
  });

  it("refuses to export data that does not match the contract", () => {
    const broken = { ...results, promos: { ...results.promos, format: 99 } } as never;
    expect(() => buildExportFile(broken, "promos-json")).toThrow();
  });
});
