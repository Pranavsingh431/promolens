import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { del, get, head, list, put } from "@vercel/blob";

import { logEvent } from "./log.ts";

/**
 * Private object storage behind one small interface. Keys are always made by
 * the server from ids it controls and are never taken from a request.
 */

export interface ObjectStore {
  readonly kind: "vercel-blob" | "local" | "memory";
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  /** Null when the object does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  delete(keys: readonly string[]): Promise<void>;
  /** Every key under a prefix. */
  list(prefix: string): Promise<string[]>;
  /**
   * Asks the storage host for the object with no credentials at all. True means
   * anyone could read it, and the upload must be refused.
   */
  isPubliclyReadable?(key: string): Promise<boolean>;
}

export function assertSafeKey(key: string): void {
  if (!/^[a-z0-9][a-z0-9/_.-]*$/i.test(key) || key.split("/").includes("..")) {
    throw new Error("Unsafe storage key.");
  }
}

/**
 * Limits on one read of a private object. Measured on 2026-11-10 with a 25 MB
 * object: under 1 s inside the store's region, and anywhere from 3 s to a steady
 * 187 s over a long-distance link. So a slow read that keeps delivering data is
 * left alone, and only silence counts as a stall. The total keeps a read, its
 * retries, and the checks after it inside the 300 s function limit.
 */
export const BLOB_READ = { totalMs: 240_000, stallMs: 15_000, attempts: 3 } as const;
export type BlobReadLimits = { totalMs: number; stallMs: number; attempts: number };

/** How long the anonymous privacy check may take before it counts as not proven. */
const PRIVACY_CHECK_MS = 20_000;

/** Resolves with the work, or rejects once the signal aborts, whichever comes first. */
function beforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}

class ShortReadError extends Error {}

/** Reads a whole body, reporting each chunk so a silent connection can be told from a slow one. */
async function readBody(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number | null,
  onData: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    onData();
  }
  if (expectedBytes !== null && total !== expectedBytes) {
    throw new ShortReadError("The object ended before all of it arrived.");
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

/**
 * Worth another try: a dropped connection (undici reports these as TypeError),
 * a short read, or a server-side status. A permissions or configuration error
 * will fail the same way again, so it is passed straight on.
 */
function isTransientRead(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof ShortReadError) return true;
  return error instanceof Error && /Failed to fetch blob: (408|425|429|5\d\d)/.test(error.message);
}

export function vercelBlobStore(read: BlobReadLimits = BLOB_READ): ObjectStore {
  return {
    kind: "vercel-blob",
    async put(key, body, contentType) {
      assertSafeKey(key);
      await put(key, Buffer.from(body as Uint8Array), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType,
      });
    },
    async get(key) {
      assertSafeKey(key);
      const overall = AbortSignal.timeout(read.totalMs);
      for (let attempt = 1; ; attempt++) {
        // Aborting this cancels the request. Checked against the real store on
        // 2026-11-10, both before the response starts and part way through its body.
        const controller = new AbortController();
        const giveUp = () => controller.abort(new Error("The storage read timed out."));
        overall.addEventListener("abort", giveUp, { once: true });
        let silence = setTimeout(giveUp, read.stallMs);
        const heardFrom = () => {
          clearTimeout(silence);
          silence = setTimeout(giveUp, read.stallMs);
        };
        try {
          // Reads must see the latest write: a retried step may have just written this.
          const result = await beforeAbort(
            get(key, { access: "private", useCache: false, abortSignal: controller.signal }),
            controller.signal,
          );
          if (!result || result.statusCode !== 200) return null;
          heardFrom();
          // The SDK reports size 0 when the length is unknown, and a compressed
          // response's length is not the length of what comes out.
          const compressed = result.headers.get("content-encoding") !== null;
          const expected = compressed || result.blob.size === 0 ? null : result.blob.size;
          return await beforeAbort(readBody(result.stream, expected, heardFrom), controller.signal);
        } catch (error) {
          const timedOut = controller.signal.aborted;
          // Whatever went wrong, the connection is released before anything else happens.
          controller.abort();
          const worthRetrying = timedOut || isTransientRead(error);
          if (attempt >= read.attempts || overall.aborted || !worthRetrying) throw error;
          logEvent("storage.read-retry", {
            attempt,
            errorCategory: timedOut ? "stalled" : "transient",
          });
        } finally {
          overall.removeEventListener("abort", giveUp);
          clearTimeout(silence);
        }
      }
    },
    async delete(keys) {
      keys.forEach(assertSafeKey);
      if (keys.length) await del([...keys]);
    },
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix, ...(cursor ? { cursor } : {}) });
        keys.push(...page.blobs.map((b) => b.pathname));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return keys;
    },
    async isPubliclyReadable(key) {
      assertSafeKey(key);
      const signal = AbortSignal.timeout(PRIVACY_CHECK_MS);
      const { url } = await head(key, { abortSignal: signal });
      const response = await fetch(url, {
        headers: { range: "bytes=0-0" },
        redirect: "manual",
        cache: "no-store",
        signal,
      });
      // Never await this cancel. Inside Next.js a fetched body can be one branch of
      // a teed stream, and cancelling one branch only settles once the other is
      // cancelled too. Awaiting it hung every upload completion on Vercel until the
      // 300 s limit. At most one byte is left unread.
      void response.body?.cancel().catch(() => {});
      if (response.ok) return true;
      if ([401, 403, 404].includes(response.status)) return false;
      // A redirect or a server error proves nothing, so the object is not accepted as private.
      throw new Error(`Could not confirm privacy: status ${response.status}.`);
    },
  };
}

/** For local development only. The configuration refuses it on Vercel. */
export function localFileStore(root: string): ObjectStore {
  const base = resolve(root);
  const pathOf = (key: string) => {
    assertSafeKey(key);
    const full = resolve(base, key);
    if (!full.startsWith(base + sep)) throw new Error("Unsafe storage key.");
    return full;
  };
  return {
    kind: "local",
    async put(key, body) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, body, { mode: 0o600 });
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(pathOf(key)));
      } catch {
        return null;
      }
    },
    async delete(keys) {
      await Promise.all(keys.map((key) => rm(pathOf(key), { force: true })));
    },
    async list(prefix) {
      try {
        const names = await readdir(base, { recursive: true, withFileTypes: true });
        return names
          .filter((entry) => entry.isFile())
          .map((entry) => relative(base, join(entry.parentPath, entry.name)).split(sep).join("/"))
          .filter((key) => key.startsWith(prefix));
      } catch {
        return [];
      }
    },
  };
}

export function memoryStore(): ObjectStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    kind: "memory",
    objects,
    async put(key, body) {
      assertSafeKey(key);
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

export const showPrefix = (ownerId: string, showId: string) => `shows/${ownerId}/${showId}/`;
export const jobPrefix = (ownerId: string, jobId: string) => `jobs/${ownerId}/${jobId}/`;
