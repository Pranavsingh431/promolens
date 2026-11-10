import { z } from "zod";

import { ApiError } from "./api-error.ts";
import { readSession, type Editor } from "./auth.ts";
import { getBackend, type Backend } from "./backend.ts";
import type { BackendConfig } from "./config.ts";
import { logEvent } from "./log.ts";
import { hitRateLimit } from "./rate-limit.ts";
import { isLocalDeployment, sessionCookieName } from "./session-cookie.ts";
import { readLimited } from "./uploads.ts";

export { sessionCookieName };

/**
 * What every API route shares. A protected route checks, in order: configured,
 * same origin for writes, signed in, under the rate limit. A deployment with
 * missing credentials refuses everything.
 */

const JSON_LIMIT_BYTES = 16 * 1024;

export const NO_STORE = "private, no-store";
/** Kept by this browser only and always rechecked with the server, which verifies the owner. */
export const REVALIDATE = "private, no-cache";

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (!headers.has("cache-control")) headers.set("cache-control", NO_STORE);
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json(
      { error: { code: error.code, message: error.message } },
      {
        status: error.status,
        ...(error.retryAfterSeconds
          ? { headers: { "retry-after": String(error.retryAfterSeconds) } }
          : {}),
      },
    );
  }
  logEvent("api.error", { errorCategory: "unexpected" });
  return json(
    { error: { code: "server", message: "Something went wrong. Try again." } },
    { status: 500 },
  );
}

export const notFound = () => new ApiError(404, "not-found", "That was not found.");

export function sessionCookie(config: BackendConfig, token: string, expires: Date): string {
  const attributes = [
    `${sessionCookieName(config)}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expires.toUTCString()}`,
  ];
  if (!isLocalDeployment(config)) attributes.push("Secure");
  return attributes.join("; ");
}

export const clearedSessionCookie = (config: BackendConfig) =>
  sessionCookie(config, "", new Date(0));

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || undefined;
    }
  }
  return undefined;
}

/** Refuses a write that did not come from this site's own pages. */
export function assertSameOrigin(request: Request): void {
  const refused = new ApiError(403, "forbidden", "That request was not allowed.");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") throw refused;
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) throw refused;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw refused;
  }
  if (originHost !== host) throw refused;
}

export async function requireBackend(): Promise<Backend> {
  const backend = await getBackend();
  if (!backend) throw new ApiError(503, "not-configured", "Analysis is not connected.");
  return backend;
}

export type RateRule = { name: string; limit: number; windowMs: number };

export async function enforceRate(backend: Backend, key: string, rule: RateRule): Promise<void> {
  const result = await hitRateLimit(backend.db, `${rule.name}:${key}`, rule.limit, rule.windowMs);
  if (!result.allowed) {
    throw new ApiError(
      429,
      "rate-limited",
      "Too many requests. Wait a moment and try again.",
      result.retryAfterSeconds,
    );
  }
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const bytes = await readLimited(request.body, JSON_LIMIT_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "invalid-request", "That request was not valid.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid-request", "That request was not valid.");
  return parsed.data;
}

export type EditorContext<P> = {
  backend: Backend;
  editor: Editor;
  request: Request;
  params: P;
};

export function editorRoute<P = Record<string, never>>(
  options: { write?: boolean; rate?: RateRule },
  handler: (context: EditorContext<P>) => Promise<Response>,
) {
  return async (request: Request, route: { params: Promise<P> }): Promise<Response> => {
    try {
      const backend = await requireBackend();
      if (options.write) assertSameOrigin(request);
      const token = readCookie(request, sessionCookieName(backend.config));
      const editor = token ? await readSession(backend.db, token) : null;
      if (!editor) throw new ApiError(401, "unauthorized", "Please sign in.");
      if (options.rate) await enforceRate(backend, editor.id, options.rate);
      return await handler({ backend, editor, request, params: await route.params });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

const uuid = z.uuid();

/** A malformed id is treated exactly like one that does not exist. */
export function parseId(value: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const RATES = {
  signInByAddress: { name: "signin-ip", limit: 10, windowMs: 15 * MINUTE },
  signInByName: { name: "signin-name", limit: 20, windowMs: 15 * MINUTE },
  uploads: { name: "uploads", limit: 30, windowMs: HOUR },
  /** One upload takes several of these calls, so they are counted apart from new uploads. */
  uploadSteps: { name: "upload-steps", limit: 150, windowMs: HOUR },
  analyses: { name: "analyses", limit: 30, windowMs: HOUR },
  retries: { name: "retries", limit: 30, windowMs: HOUR },
  reads: { name: "reads", limit: 300, windowMs: MINUTE },
  exports: { name: "exports", limit: 60, windowMs: MINUTE },
} satisfies Record<string, RateRule>;

export const clientAddress = (request: Request) =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
  request.headers.get("x-real-ip") ||
  "local";
