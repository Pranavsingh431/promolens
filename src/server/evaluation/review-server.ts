import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  checkClip,
  emptyAnnotationFile,
  mergeAnnotationSave,
  readAnnotationFile,
  reviewerCodeSchema,
  validateAnnotations,
  type AnnotationFile,
} from "../../domain/evaluation/annotation.ts";
import {
  coldViewerView,
  itemVisible,
  partAView,
  type ReviewItems,
} from "../../domain/evaluation/review.ts";
import {
  CRITERIA,
  ESSENTIAL_CRITERIA,
  KEEP_MINIMUM,
  KEEP_REASONS,
  REJECT_REASONS,
  RUBRIC_VERSION,
  WEAKNESSES,
} from "../../domain/evaluation/rubric.ts";
import type { EvaluationSample } from "../../domain/evaluation/sample.ts";
import type { Timeline } from "../../domain/screenplay/timeline.ts";
import { workspacePaths, writeJsonAtomic } from "./workspace.ts";

/**
 * Local review tool for human annotators. Binds to 127.0.0.1 only and accepts
 * requests only for its own host name, so other sites cannot read it.
 *
 * Reviewers see on-screen events only. Part B items never reveal the episode,
 * the method, the score, or the clip position. The review key stays on disk.
 */

export type ReviewContext = {
  dir: string;
  timeline: Timeline;
  sample: EvaluationSample;
  items: ReviewItems;
  /** When set, Part A shows only these episodes and Part B hides clips from the other split. */
  only?: readonly number[];
  now?: () => string;
};

function visibleEpisodes(context: ReviewContext): number[] {
  return context.sample.episodes
    .map((e) => e.episode)
    .filter((episode) => !context.only || context.only.includes(episode));
}

function visibleItems(context: ReviewContext): ReviewItems["items"] {
  const sampled = new Set(context.sample.episodes.map((e) => e.episode));
  return context.items.items.filter((item) => itemVisible(item, sampled, context.only));
}

const MAX_BODY_BYTES = 1024 * 1024;
const PAGE = new URL("./review-page.html", import.meta.url);

class HttpError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(String(status));
    this.status = status;
    this.body = body;
  }
}

export function createReviewServer(context: ReviewContext): Server {
  return createServer((request, response) => {
    handle(request, response, context).catch((error: unknown) => {
      if (error instanceof HttpError) sendJson(response, error.status, error.body);
      else sendJson(response, 500, { error: "Internal error." });
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse, context: ReviewContext) {
  const host = request.headers.host ?? "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
    throw new HttpError(403, { error: "Forbidden host." });

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  const route = `${method} ${url.pathname}`;

  if (route === "GET /") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(await readFile(PAGE, "utf8"));
    return;
  }
  if (route === "GET /api/session") {
    sendJson(response, 200, {
      rubric: {
        version: RUBRIC_VERSION,
        criteria: CRITERIA,
        essential: ESSENTIAL_CRITERIA,
        keepMinimum: KEEP_MINIMUM,
        keepReasons: KEEP_REASONS,
        rejectReasons: REJECT_REASONS,
        weaknesses: WEAKNESSES,
      },
      sampleVersion: context.sample.version,
      episodes: visibleEpisodes(context),
      items: visibleItems(context).map((item) => item.itemId),
    });
    return;
  }

  const annotation = /^\/api\/annotations\/([^/]+)$/.exec(url.pathname);
  if (annotation) {
    const reviewer = reviewerCodeSchema.safeParse(decodeURIComponent(annotation[1] ?? ""));
    if (!reviewer.success) throw new HttpError(400, { error: "Invalid reviewer code." });
    if (method === "GET") {
      sendJson(response, 200, forBrowser(await loadAnnotation(context, reviewer.data)));
      return;
    }
    if (method === "PUT") {
      sendJson(
        response,
        200,
        await saveAnnotation(context, reviewer.data, await readBody(request)),
      );
      return;
    }
  }

  const episode = /^\/api\/episodes\/(\d+)$/.exec(url.pathname);
  if (episode && method === "GET") {
    const number = Number(episode[1]);
    if (!visibleEpisodes(context).includes(number)) {
      throw new HttpError(404, { error: "Episode is not in the sample." });
    }
    sendJson(response, 200, partAView(context.timeline, number));
    return;
  }

  const item = /^\/api\/items\/(B\d+)$/.exec(url.pathname);
  if (item && method === "GET") {
    const shown = visibleItems(context);
    const index = shown.findIndex((i) => i.itemId === item[1]);
    const found = shown[index];
    if (!found) throw new HttpError(404, { error: "Unknown review item." });
    sendJson(response, 200, {
      itemId: found.itemId,
      position: index + 1,
      total: shown.length,
      ...coldViewerView(context.timeline, found.segments),
    });
    return;
  }

  if (route === "POST /api/check") {
    const body = (await readBody(request)) as { segments?: unknown };
    const segments = Array.isArray(body.segments) ? body.segments : [];
    const valid = segments.every(
      (s: { episode?: unknown; startMs?: unknown; endMs?: unknown }) =>
        context.sample.episodes.some((e) => e.episode === s.episode) &&
        Number.isInteger(s.startMs) &&
        Number.isInteger(s.endMs),
    );
    if (!segments.length || !valid) throw new HttpError(400, { error: "Invalid segments." });
    sendJson(response, 200, { issues: checkClip(segments, context.timeline) });
    return;
  }

  throw new HttpError(404, { error: "Not found." });
}

async function loadAnnotation(context: ReviewContext, reviewer: string): Promise<AnnotationFile> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(workspacePaths(context.dir).annotation(reviewer), "utf8"),
    );
    const read = readAnnotationFile(raw);
    if (!read.ok)
      throw new HttpError(500, { error: "Saved annotation file is invalid.", issues: read.issues });
    return read.file;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return emptyAnnotationFile(reviewer, context.sample.version);
  }
}

/** Clip keys reveal episode and position, so they never reach the browser. */
function forBrowser(file: AnnotationFile) {
  return {
    ...file,
    partB: file.partB.map((review) => ({
      itemId: review.itemId,
      judgment: review.judgment,
      version: review.version,
      updatedAt: review.updatedAt,
    })),
  };
}

async function saveAnnotation(context: ReviewContext, reviewer: string, body: unknown) {
  const { baseRevision, file } = (body ?? {}) as {
    baseRevision?: unknown;
    file?: Record<string, unknown>;
  };
  if (!Number.isInteger(baseRevision) || !file || typeof file !== "object") {
    throw new HttpError(400, { error: "Expected { baseRevision, file }." });
  }
  const now = (context.now ?? (() => new Date().toISOString()))();
  const keys = new Map(context.items.items.map((i) => [i.itemId, i.clipKey]));
  const stamp = <T extends object>(record: T) => ({ version: 1, updatedAt: now, ...record });

  const incoming = {
    ...file,
    reviewer,
    partA: Array.isArray(file.partA)
      ? file.partA.map((entry: { moments?: unknown[] }) => ({
          ...entry,
          moments: Array.isArray(entry.moments)
            ? entry.moments.map((m) => stamp(m as object))
            : entry.moments,
        }))
      : file.partA,
    partB: Array.isArray(file.partB)
      ? file.partB.map((review: { itemId?: string }) => ({
          ...stamp(review),
          clipKey: keys.get(review.itemId ?? "") ?? "",
        }))
      : file.partB,
  };

  const read = readAnnotationFile(incoming);
  if (!read.ok) throw new HttpError(400, { error: "Annotation is invalid.", issues: read.issues });
  const issues = validateAnnotations(read.file, context);
  if (issues.some((i) => i.severity === "error")) {
    throw new HttpError(400, { error: "Annotation is invalid.", issues });
  }

  const existing = await loadAnnotation(context, reviewer);
  const merged = mergeAnnotationSave(existing, read.file, {
    baseRevision: baseRevision as number,
    now,
    items: context.items,
  });
  if (!merged.ok) {
    throw new HttpError(409, {
      error: "This file changed since you loaded it. Reload to continue.",
    });
  }
  await writeJsonAtomic(workspacePaths(context.dir).annotation(reviewer), merged.file);
  return { revision: merged.file.revision, warnings: issues, file: forBrowser(merged.file) };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, { error: "Send JSON." });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, { error: "Request is too large." });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, { error: "Body is not valid JSON." });
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}
