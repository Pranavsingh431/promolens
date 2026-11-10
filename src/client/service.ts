import type { AnalysisJob, JobSummary } from "@/domain/analysis-job";
import type { PromoExport, RankingOutput } from "@/domain/ranking/output";
import type { Episode } from "@/domain/screenplay/schema";

/**
 * Everything the workspace needs from a backend. Components talk only to this
 * interface, so the real service and the demo are interchangeable.
 *
 * Results use the rank-3 contracts directly: `ranking` is ranking.json and
 * `promos` is promos.json. There is no separate result format for the browser.
 */

export type ExportFormat = "promos-csv" | "promos-json" | "ranking-json";

export type ExportFile = { fileName: string; mimeType: string; content: string };

export type UploadProgress = { loadedBytes: number; totalBytes: number };

export type AnalysisResults = { ranking: RankingOutput; promos: PromoExport };

export type RequestOptions = { signal?: AbortSignal };

export interface AnalysisService {
  /** Sends the file only when called. Nothing is uploaded before the editor presses Analyze. */
  startAnalysis(
    file: File,
    options: RequestOptions & {
      onUploadProgress?: (progress: UploadProgress) => void;
      /** How many promos the editor asked for. The server's default when absent. */
      count?: number;
    },
  ): Promise<AnalysisJob>;
  getJob(jobId: string, options?: RequestOptions): Promise<AnalysisJob>;
  cancelJob(jobId: string): Promise<AnalysisJob>;
  getResults(jobId: string, options?: RequestOptions): Promise<AnalysisResults>;
  /** One episode of the source screenplay, loaded only when a clip from it is inspected. */
  getEpisode(jobId: string, episode: number, options?: RequestOptions): Promise<Episode>;
  exportResults(jobId: string, format: ExportFormat): Promise<ExportFile>;
  /** Runs a stopped analysis again, reusing every answer already paid for. */
  retryJob?(jobId: string): Promise<AnalysisJob>;
  /** Asks the same show for a different number of promos, reusing every answer already paid for. */
  requestMore?(jobId: string, count: number): Promise<AnalysisJob>;
  listJobs?(options?: RequestOptions): Promise<JobSummary[]>;
  /** Removes a show and everything made from it. */
  deleteShow?(showId: string): Promise<void>;
}

export type ServiceErrorKind =
  | "unavailable"
  | "network"
  | "invalid-file"
  | "not-found"
  | "server"
  | "invalid-response"
  | "unauthorized"
  | "rate-limited"
  | "over-budget";

export class ServiceError extends Error {
  readonly kind: ServiceErrorKind;
  readonly retryable: boolean;

  constructor(kind: ServiceErrorKind, message: string, retryable = false) {
    super(message);
    this.name = "ServiceError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

export function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  return new ServiceError("network", "The request could not be completed.", true);
}
