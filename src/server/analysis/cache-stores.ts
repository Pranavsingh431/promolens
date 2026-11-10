import { and, eq, inArray, sql } from "drizzle-orm";

import {
  cacheKey,
  decodeCacheEntry,
  CACHE_FORMAT,
  type CacheKeyParts,
  type DiscoveryCacheStore,
} from "../discovery/cache.ts";
import type { Database } from "../db/client.ts";
import { inferenceCache } from "../db/schema.ts";
import {
  decodeStageEntry,
  encodeStageEntry,
  stageCacheKey,
  type StageCacheStore,
  type StoredRefusal,
} from "../ranking/cache.ts";
import { RANKING_CACHE_FORMAT } from "../ranking/cache.ts";

/**
 * The same content-addressed cache as the command-line tools, kept in
 * PostgreSQL so it survives between function invocations. Entries go through
 * the same validation on the way out as the file cache.
 *
 * Reads made in the same tick become one query, which is what keeps a stage
 * that looks up hundreds of judgments from making hundreds of round trips.
 */

type Row = { entry: unknown; refusedKind: string | null; createdAt: Date };

function createLoader(db: Database, ownerId: string) {
  const memo = new Map<string, Promise<Row | null>>();
  let pending: Array<{
    key: string;
    resolve: (row: Row | null) => void;
    reject: (e: unknown) => void;
  }> = [];

  async function flush() {
    const batch = pending;
    pending = [];
    try {
      const rows = await db
        .select({
          cacheKey: inferenceCache.cacheKey,
          entry: inferenceCache.entry,
          refusedKind: inferenceCache.refusedKind,
          createdAt: inferenceCache.createdAt,
        })
        .from(inferenceCache)
        .where(
          and(
            eq(inferenceCache.ownerId, ownerId),
            inArray(
              inferenceCache.cacheKey,
              batch.map((b) => b.key),
            ),
          ),
        );
      const found = new Map(rows.map((r) => [r.cacheKey, r]));
      for (const item of batch) item.resolve(found.get(item.key) ?? null);
    } catch (error) {
      for (const item of batch) item.reject(error);
    }
  }

  return {
    load(key: string): Promise<Row | null> {
      let request = memo.get(key);
      if (!request) {
        request = new Promise<Row | null>((resolve, reject) => {
          if (pending.length === 0) queueMicrotask(() => void flush());
          pending.push({ key, resolve, reject });
        });
        memo.set(key, request);
      }
      return request;
    },
    forget(key: string) {
      memo.delete(key);
    },
  };
}

async function writeEntry(
  db: Database,
  scope: { ownerId: string; showId: string },
  key: string,
  kind: string,
  entry: unknown,
) {
  await db
    .insert(inferenceCache)
    .values({ ...scope, cacheKey: key, kind, entry, refusedKind: null })
    .onConflictDoUpdate({
      target: [inferenceCache.ownerId, inferenceCache.cacheKey],
      set: { entry, refusedKind: null },
    });
}

async function writeRefused(
  db: Database,
  scope: { ownerId: string; showId: string },
  key: string,
  kind: string,
  refusedKind: string,
) {
  await db
    .insert(inferenceCache)
    .values({ ...scope, cacheKey: key, kind, entry: null, refusedKind })
    .onConflictDoUpdate({
      target: [inferenceCache.ownerId, inferenceCache.cacheKey],
      set: { refusedKind },
      setWhere: sql`${inferenceCache.entry} is null`,
    });
}

export function databaseStageCache(
  db: Database,
  scope: { ownerId: string; showId: string },
): StageCacheStore {
  const loader = createLoader(db, scope.ownerId);
  return {
    async read(parts, parse) {
      const row = await loader.load(stageCacheKey(parts));
      if (!row?.entry) return { status: "miss" };
      return decodeStageEntry(row.entry, parts, parse);
    },
    async write(parts, response, meta, createdAt) {
      const entry = encodeStageEntry(parts, response, meta, createdAt);
      await writeEntry(db, scope, entry.key, "ranking", entry);
      loader.forget(entry.key);
      return entry.key;
    },
    async readRefusal(parts) {
      const key = stageCacheKey(parts);
      const row = await loader.load(key);
      if (!row?.refusedKind) return null;
      return {
        format: RANKING_CACHE_FORMAT,
        key,
        kind: row.refusedKind as StoredRefusal["kind"],
        createdAt: row.createdAt.toISOString(),
      };
    },
    async writeRefusal(parts, kind) {
      const key = stageCacheKey(parts);
      await writeRefused(db, scope, key, "ranking", kind);
      loader.forget(key);
    },
  };
}

export function databaseDiscoveryCache(
  db: Database,
  scope: { ownerId: string; showId: string },
): DiscoveryCacheStore {
  const loader = createLoader(db, scope.ownerId);
  return {
    async read(parts: CacheKeyParts) {
      const row = await loader.load(cacheKey(parts));
      if (!row?.entry) return { status: "miss" };
      return decodeCacheEntry(row.entry, parts);
    },
    async write(entry) {
      const key = cacheKey(entry.parts);
      await writeEntry(db, scope, key, "discovery", { format: CACHE_FORMAT, key, ...entry });
      loader.forget(key);
      return key;
    },
    async readRefusal(parts) {
      const row = await loader.load(cacheKey(parts));
      return row?.refusedKind ?? null;
    },
    async writeRefusal(parts, kind) {
      const key = cacheKey(parts);
      await writeRefused(db, scope, key, "discovery", kind);
      loader.forget(key);
    },
  };
}
