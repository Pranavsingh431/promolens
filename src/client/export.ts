import { promoExportSchema, rankingOutputSchema, renderPromosCsv } from "@/domain/ranking/output";

import type { AnalysisResults, ExportFile, ExportFormat } from "./service";

/**
 * Export files in the existing rank-3 formats. Every file is checked against
 * its schema first, so a download always matches what the engine writes.
 */

function baseName(results: AnalysisResults): string {
  const run = results.ranking.runId.replace(/[^\w-]+/g, "-");
  const partial = results.ranking.status === "partial" ? "-partial" : "";
  return `promolens-${run}${partial}`;
}

export function buildExportFile(results: AnalysisResults, format: ExportFormat): ExportFile {
  const name = baseName(results);
  switch (format) {
    case "promos-csv":
      return {
        fileName: `${name}-promos.csv`,
        mimeType: "text/csv;charset=utf-8",
        content: renderPromosCsv(promoExportSchema.parse(results.promos)),
      };
    case "promos-json":
      return {
        fileName: `${name}-promos.json`,
        mimeType: "application/json",
        content: `${JSON.stringify(promoExportSchema.parse(results.promos), null, 2)}\n`,
      };
    case "ranking-json":
      return {
        fileName: `${name}-ranking.json`,
        mimeType: "application/json",
        content: `${JSON.stringify(rankingOutputSchema.parse(results.ranking), null, 2)}\n`,
      };
  }
}

export function saveFile(file: ExportFile): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.fileName;
  link.click();
  URL.revokeObjectURL(url);
}
