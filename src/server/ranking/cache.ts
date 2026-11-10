import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { contentHash } from "../discovery/cache.ts";
import { writeJsonAtomic } from "../write-json-atomic.ts";

/**
 * File cache for validated ranking judgments, one JSON file per key, written
 * atomically. The key covers everything the model saw and everything that
 * shapes its answer: the stage, the exact clip boundaries and events (or both
 * clips of a pair, in the order shown), the full prompt, the JSON schema, the
 * prompt and rubric versions, the model and its settings, the privacy mode,
 * and the replicate number. Only answers that passed validation are stored.
 *
 * Scores are never cached. They are recomputed from these judgments with the
 * current ranking configuration on every run.
 *
 * A refusal is stored beside the judgments, under the same key, so a request
 * the provider has already declined is not sent again on every re-run.
 */

export const RANKING_CACHE_FORMAT = 1;

const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const stageKeyPartsSchema = z.object({
  stage: z.enum(["screen", "cold-viewer", "editorial", "pairwise"]),
  promptVersion: z.string(),
  rubricVersion: z.string(),
  /** Hash of the clip boundaries and the events shown, or of both clips for a pair. */
  subjectSha256: hash,
  promptSha256: hash,
  jsonSchemaSha256: hash,
  model: z.string(),
  maxTokens: z.number().int().positive(),
  reasoningEffort: z.string().nullable(),
  privacy: z.string(),
  replicate: z.number().int().nonnegative(),
});
export type StageKeyParts = z.infer<typeof stageKeyPartsSchema>;

export function stageCacheKey(parts: StageKeyParts): string {
  return contentHash({ format: RANKING_CACHE_FORMAT, ...parts });
}

const metaSchema = z.object({
  generationId: z.string().nullable(),
  provider: z.string().nullable(),
  servedModel: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  latencyMs: z.number().nonnegative(),
  billedUsd: z.number().nullable(),
  estimatedUsd: z.number().nonnegative(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    reasoningTokens: z.number(),
    cachedTokens: z.number(),
  }),
});
export type StageMeta = z.infer<typeof metaSchema>;

const entrySchema = z.object({
  format: z.literal(RANKING_CACHE_FORMAT),
  key: hash,
  parts: stageKeyPartsSchema,
  createdAt: z.string(),
  response: z.unknown(),
  meta: metaSchema,
});

export type StageCacheRead<T> =
  | { status: "hit"; response: T; meta: StageMeta; createdAt: string }
  | { status: "miss" }
  | { status: "corrupt"; reason: string };

/**
 * Where validated judgments are kept. The file store serves the command-line
 * tools; the web backend keeps the same entries in PostgreSQL. Every store
 * goes through the same checks, so a damaged or tampered entry is never trusted.
 */
export interface StageCacheStore {
  read<T>(parts: StageKeyParts, parse: (value: unknown) => T): Promise<StageCacheRead<T>>;
  write(
    parts: StageKeyParts,
    response: unknown,
    meta: StageMeta,
    createdAt?: string,
  ): Promise<string>;
  readRefusal(parts: StageKeyParts): Promise<StoredRefusal | null>;
  writeRefusal(
    parts: StageKeyParts,
    kind: StoredRefusal["kind"],
    createdAt?: string,
  ): Promise<void>;
}

/** Validates a stored entry against the key it should have. */
export function decodeStageEntry<T>(
  data: unknown,
  parts: StageKeyParts,
  parse: (value: unknown) => T,
): StageCacheRead<T> {
  const key = stageCacheKey(parts);
  const entry = entrySchema.safeParse(data);
  if (!entry.success) return { status: "corrupt", reason: "does not match the cache format" };
  if (entry.data.key !== key || stageCacheKey(entry.data.parts) !== key) {
    return { status: "corrupt", reason: "key does not match its contents" };
  }
  try {
    return {
      status: "hit",
      response: parse(entry.data.response),
      meta: entry.data.meta,
      createdAt: entry.data.createdAt,
    };
  } catch {
    return { status: "corrupt", reason: "stored answer no longer passes validation" };
  }
}

export function refusalRecord(
  parts: StageKeyParts,
  kind: StoredRefusal["kind"],
  createdAt = new Date().toISOString(),
): StoredRefusal {
  return { format: RANKING_CACHE_FORMAT, key: stageCacheKey(parts), kind, createdAt };
}

export function encodeStageEntry(
  parts: StageKeyParts,
  response: unknown,
  meta: StageMeta,
  createdAt = new Date().toISOString(),
) {
  return {
    format: RANKING_CACHE_FORMAT,
    key: stageCacheKey(parts),
    parts,
    createdAt,
    response,
    meta,
  };
}

export async function readStageCache<T>(
  dir: string,
  parts: StageKeyParts,
  parse: (value: unknown) => T,
): Promise<StageCacheRead<T>> {
  const key = stageCacheKey(parts);
  let text: string;
  try {
    text = await readFile(join(dir, `${key}.json`), "utf8");
  } catch {
    return { status: "miss" };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { status: "corrupt", reason: "not JSON" };
  }
  return decodeStageEntry(data, parts, parse);
}

export async function writeStageCache(
  dir: string,
  parts: StageKeyParts,
  response: unknown,
  meta: StageMeta,
  createdAt = new Date().toISOString(),
): Promise<string> {
  const entry = encodeStageEntry(parts, response, meta, createdAt);
  await writeJsonAtomic(join(dir, `${entry.key}.json`), entry);
  return entry.key;
}

const refusalSchema = z.object({
  format: z.literal(RANKING_CACHE_FORMAT),
  key: hash,
  kind: z.enum(["content-policy", "refusal"]),
  createdAt: z.string(),
});
export type StoredRefusal = z.infer<typeof refusalSchema>;
export { refusalSchema };

const refusalFile = (dir: string, key: string) => join(dir, `${key}.refused.json`);

/** A recorded refusal for this exact request, or null. A damaged record counts as none. */
export async function readStageRefusal(
  dir: string,
  parts: StageKeyParts,
): Promise<StoredRefusal | null> {
  const key = stageCacheKey(parts);
  try {
    const refusal = refusalSchema.parse(JSON.parse(await readFile(refusalFile(dir, key), "utf8")));
    return refusal.key === key ? refusal : null;
  } catch {
    return null;
  }
}

export async function writeStageRefusal(
  dir: string,
  parts: StageKeyParts,
  kind: StoredRefusal["kind"],
  createdAt = new Date().toISOString(),
): Promise<void> {
  const key = stageCacheKey(parts);
  await writeJsonAtomic(refusalFile(dir, key), {
    format: RANKING_CACHE_FORMAT,
    key,
    kind,
    createdAt,
  });
}

export function fileStageCache(dir: string): StageCacheStore {
  return {
    read: (parts, parse) => readStageCache(dir, parts, parse),
    write: (parts, response, meta, createdAt) =>
      writeStageCache(dir, parts, response, meta, createdAt),
    readRefusal: (parts) => readStageRefusal(dir, parts),
    writeRefusal: (parts, kind, createdAt) => writeStageRefusal(dir, parts, kind, createdAt),
  };
}
