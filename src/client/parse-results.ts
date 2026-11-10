import { promoExportSchema, rankingOutputSchema } from "@/domain/ranking/output";

import { ServiceError, type AnalysisResults } from "./service";

/**
 * Checks results against the rank-3 schemas where they enter the browser.
 * Kept in its own module so the schemas load only when there are results.
 */
export function parseResults(raw: AnalysisResults): AnalysisResults {
  const ranking = rankingOutputSchema.safeParse(raw.ranking);
  const promos = promoExportSchema.safeParse(raw.promos);
  if (!ranking.success || !promos.success) {
    throw new ServiceError("invalid-response", "The results did not match the expected format.");
  }
  return { ranking: ranking.data, promos: promos.data };
}
