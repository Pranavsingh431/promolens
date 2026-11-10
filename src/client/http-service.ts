import { z } from "zod";

import { analysisJobSchema, jobSummarySchema, type AnalysisJob } from "@/domain/analysis-job";
import { episodeSchema } from "@/domain/screenplay/schema";

import {
  ServiceError,
  toServiceError,
  type AnalysisResults,
  type AnalysisService,
  type ExportFormat,
  type ServiceErrorKind,
} from "./service";

/**
 * The real analysis service. Every response is checked against the shared
 * schemas before anything on screen uses it, and there is no fallback to
 * sample data: when the server cannot answer, the editor sees an error.
 */

const MAX_POLL_MS = 15_000;

const ticketSchema = z.object({
  uploadId: z.string().min(1),
  transport: z.enum(["direct", "server"]),
  pathname: z.string().min(1),
});
const completedSchema = z.object({ showId: z.string().min(1) });
const jobResponseSchema = z.object({ job: analysisJobSchema });
const listSchema = z.object({ analyses: z.array(jobSummarySchema) });
const episodeResponseSchema = z.object({ episode: episodeSchema });

function kindForStatus(status: number, code: string): { kind: ServiceErrorKind; retry: boolean } {
  if (status === 401) return { kind: "unauthorized", retry: false };
  if (status === 404 || status === 410) return { kind: "not-found", retry: false };
  if (code === "over-budget") return { kind: "over-budget", retry: false };
  if (status === 413 || status === 415 || status === 422) {
    return { kind: "invalid-file", retry: false };
  }
  if (status === 429) return { kind: "rate-limited", retry: code !== "budget-reached" };
  if (code === "not-configured") return { kind: "unavailable", retry: false };
  return { kind: "server", retry: status >= 500 };
}

async function failure(response: Response): Promise<ServiceError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  const { kind, retry } = kindForStatus(response.status, body?.error?.code ?? "");
  return new ServiceError(
    kind,
    body?.error?.message ?? "The request could not be completed.",
    retry,
  );
}

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ServiceError("invalid-response", "The server's answer was not in the expected form.");
  }
  return parsed.data;
}

export function createHttpService(): AnalysisService {
  const lastSeen = new Map<string, { tag: string; job: AnalysisJob }>();

  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(path, { cache: "no-store", ...init });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw toServiceError(error);
    }
    if (response.status !== 304 && !response.ok) throw await failure(response);
    return response;
  }

  const post = (path: string, body?: unknown, signal?: AbortSignal) =>
    send(path, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });

  const service: AnalysisService = {
    async startAnalysis(file, { signal, onUploadProgress, count }) {
      const ticket = checked(
        ticketSchema,
        await (
          await post("/api/uploads", { fileName: file.name, sizeBytes: file.size }, signal)
        ).json(),
      );
      if (ticket.transport === "direct") {
        const { uploadPresigned } = await import("@vercel/blob/client");
        await uploadPresigned(ticket.pathname, file, {
          access: "private",
          handleUploadUrl: "/api/uploads/presign",
          contentType: "application/zip",
          // A single request, because the store enforces the signed size limit only on these.
          multipart: false,
          ...(signal ? { abortSignal: signal } : {}),
          onUploadProgress: ({ loaded, total }) =>
            onUploadProgress?.({ loadedBytes: loaded, totalBytes: total }),
        }).catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") throw error;
          throw new ServiceError("network", "The upload did not finish.", true);
        });
      } else {
        await send(`/api/uploads/${ticket.uploadId}/content`, {
          method: "PUT",
          body: file,
          ...(signal ? { signal } : {}),
        });
        onUploadProgress?.({ loadedBytes: file.size, totalBytes: file.size });
      }
      const completed = checked(
        completedSchema,
        await (await post(`/api/uploads/${ticket.uploadId}/complete`, undefined, signal)).json(),
      );
      const { job } = checked(
        jobResponseSchema,
        await (
          await post(
            "/api/analyses",
            { showId: completed.showId, ...(count ? { count } : {}) },
            signal,
          )
        ).json(),
      );
      return job;
    },

    async requestMore(jobId, count) {
      return checked(
        jobResponseSchema,
        await (await post(`/api/analyses/${jobId}/more`, { count })).json(),
      ).job;
    },

    async getJob(jobId, options) {
      const seen = lastSeen.get(jobId);
      const response = await send(`/api/analyses/${jobId}`, {
        ...(seen ? { headers: { "if-none-match": seen.tag } } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (response.status === 304 && seen) {
        // Nothing has changed, so the next check can wait a little longer.
        const job = { ...seen.job, pollAfterMs: Math.min(seen.job.pollAfterMs * 1.5, MAX_POLL_MS) };
        const rounded = { ...job, pollAfterMs: Math.round(job.pollAfterMs) };
        lastSeen.set(jobId, { tag: seen.tag, job: rounded });
        return rounded;
      }
      const { job } = checked(jobResponseSchema, await response.json());
      const tag = response.headers.get("etag");
      if (tag) lastSeen.set(jobId, { tag, job });
      return job;
    },

    async cancelJob(jobId) {
      return checked(jobResponseSchema, await (await post(`/api/analyses/${jobId}/cancel`)).json())
        .job;
    },

    async retryJob(jobId) {
      return checked(jobResponseSchema, await (await post(`/api/analyses/${jobId}/retry`)).json())
        .job;
    },

    async getResults(jobId, options) {
      // Revalidated by the browser, so reopening a result does not download it again.
      const response = await send(`/api/analyses/${jobId}/results`, {
        cache: "no-cache",
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      // The caller checks this against the rank-3 schemas.
      return (await response.json()) as AnalysisResults;
    },

    async getEpisode(jobId, episode, options) {
      const response = await send(`/api/analyses/${jobId}/episodes/${episode}`, {
        cache: "no-cache",
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return checked(episodeResponseSchema, await response.json()).episode;
    },

    async exportResults(jobId, format: ExportFormat) {
      const response = await send(`/api/analyses/${jobId}/export?format=${format}`);
      const disposition = response.headers.get("content-disposition") ?? "";
      return {
        fileName: /filename="([^"]+)"/.exec(disposition)?.[1] ?? `promolens-${format}`,
        mimeType: response.headers.get("content-type") ?? "application/octet-stream",
        content: await response.text(),
      };
    },

    async listJobs(options) {
      const response = await send(
        "/api/analyses",
        options?.signal ? { signal: options.signal } : {},
      );
      return checked(listSchema, await response.json()).analyses;
    },

    async deleteShow(showId) {
      await send(`/api/shows/${showId}`, { method: "DELETE" });
    },
  };
  return service;
}

/** Waits for the tab to come back into view, so a hidden tab sends nothing. */
export function whenDocumentVisible(signal: AbortSignal): Promise<void> {
  if (document.visibilityState === "visible") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", finish);
      resolve();
    };
    document.addEventListener("visibilitychange", finish);
    signal.addEventListener("abort", () => {
      document.removeEventListener("visibilitychange", finish);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}
