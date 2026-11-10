import { DELETE as deleteSession, POST as postSession } from "../../src/app/api/session/route";
import { POST as postUploads } from "../../src/app/api/uploads/route";
import { PUT as putContent } from "../../src/app/api/uploads/[id]/content/route";
import { POST as postComplete } from "../../src/app/api/uploads/[id]/complete/route";
import { GET as listAnalyses, POST as postAnalyses } from "../../src/app/api/analyses/route";
import { GET as getAnalysis } from "../../src/app/api/analyses/[id]/route";
import { POST as postCancel } from "../../src/app/api/analyses/[id]/cancel/route";
import { POST as postRetry } from "../../src/app/api/analyses/[id]/retry/route";
import { GET as getResults } from "../../src/app/api/analyses/[id]/results/route";
import { GET as getExport } from "../../src/app/api/analyses/[id]/export/route";
import { GET as getEpisode } from "../../src/app/api/analyses/[id]/episodes/[number]/route";
import { DELETE as deleteShow } from "../../src/app/api/shows/[id]/route";
import { CODES, call } from "./backend-harness";

/** The API as an editor's browser would use it, calling the real route handlers. */

export const routes = {
  deleteSession,
  postSession,
  postUploads,
  putContent,
  postComplete,
  listAnalyses,
  postAnalyses,
  getAnalysis,
  postCancel,
  postRetry,
  getResults,
  getExport,
  getEpisode,
  deleteShow,
};

export async function signIn(name: keyof typeof CODES, previous?: string): Promise<string> {
  const response = await call(postSession, "/api/session", {
    method: "POST",
    json: { name, code: CODES[name] },
    ...(previous ? { cookie: previous } : {}),
  });
  if (response.status !== 200) throw new Error(`Sign-in failed: ${response.status}`);
  return (response.headers.get("set-cookie") as string).split(";")[0] as string;
}

export async function createUpload(cookie: string, fileName: string, sizeBytes: number) {
  return call(postUploads, "/api/uploads", {
    method: "POST",
    cookie,
    json: { fileName, sizeBytes },
  });
}

export async function uploadZip(cookie: string, zip: Uint8Array, fileName = "show.zip") {
  const created = await createUpload(cookie, fileName, zip.length);
  if (created.status !== 201) return { created, complete: null, uploadId: null };
  const { uploadId } = (await created.json()) as { uploadId: string };
  const params = { id: uploadId };
  const put = await call(
    putContent,
    `/api/uploads/${uploadId}/content`,
    { method: "PUT", cookie, body: zip as BodyInit },
    params,
  );
  if (put.status !== 200) throw new Error(`Upload failed: ${put.status}`);
  const complete = await call(
    postComplete,
    `/api/uploads/${uploadId}/complete`,
    { method: "POST", cookie },
    params,
  );
  return { created, complete, uploadId };
}

export async function uploadShow(cookie: string, zip: Uint8Array, fileName = "show.zip") {
  const { complete } = await uploadZip(cookie, zip, fileName);
  if (complete?.status !== 200) throw new Error(`Complete failed: ${complete?.status}`);
  return (await complete.json()) as { showId: string; episodes: number; duplicate: boolean };
}

export type JobView = {
  id: string;
  state: string;
  failure: { code: string; stage: string; retryable: boolean } | null;
  facts: { episodes?: number; moments?: number; progress?: unknown };
};

export async function startJob(cookie: string, showId: string) {
  const response = await call(postAnalyses, "/api/analyses", {
    method: "POST",
    cookie,
    json: { showId },
  });
  return { response, job: ((await response.clone().json()) as { job: JobView }).job };
}

export async function readJob(cookie: string, id: string): Promise<JobView> {
  const response = await call(getAnalysis, `/api/analyses/${id}`, { cookie }, { id });
  return ((await response.json()) as { job: JobView }).job;
}

export const resultsOf = (cookie: string, id: string, headers: Record<string, string> = {}) =>
  call(getResults, `/api/analyses/${id}/results`, { cookie, headers }, { id });

export const exportOf = (cookie: string, id: string, format: string) =>
  call(getExport, `/api/analyses/${id}/export?format=${format}`, { cookie }, { id });

export const episodeOf = (cookie: string, id: string, number: number) =>
  call(
    getEpisode,
    `/api/analyses/${id}/episodes/${number}`,
    { cookie },
    { id, number: String(number) },
  );
