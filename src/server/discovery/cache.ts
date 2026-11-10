import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  CONTEXT_VARIANTS,
  type ContextVariant,
} from "../../domain/discovery/prompts/discovery-v1.ts";
import { proposalResponseSchema, type ProposalResponse } from "../../domain/discovery/proposal.ts";
import type { Episode } from "../../domain/screenplay/schema.ts";
import { writeJsonAtomic } from "../write-json-atomic.ts";

/**
 * File cache for validated model responses, one JSON file per key, written
 * atomically. Only responses that passed schema validation are stored, so a
 * failed or partial call is never mistaken for a result. Any change to the
 * episode text, prompt version, schema version, model, or generation settings
 * changes the key.
 */

export const CACHE_FORMAT = 1;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Hash of everything the prompt shows the model for this episode. */
export function episodeFingerprint(episode: Episode, variant: ContextVariant): string {
  return sha256(
    canonical({
      number: episode.number,
      durationMs: episode.durationMs,
      scenes: episode.scenes.map((s) => [s.id, s.heading, s.startMs, s.endMs]),
      events: episode.events.map((e) => [
        e.seq,
        e.sceneId,
        e.kind,
        e.startMs,
        e.endMs,
        e.speaker ?? null,
        e.delivery ?? null,
        e.text,
      ]),
      writerNotes:
        variant === "writer-context"
          ? [episode.writerNotes.logline ?? null, episode.writerNotes.continuityNotes ?? null]
          : null,
    }),
  );
}

const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const cacheKeyPartsSchema = z.object({
  episodeFingerprint: hash,
  /** Hash of the exact system and user prompt sent, so a wording change can never reuse old results. */
  promptSha256: hash,
  /** Hash of the JSON schema sent as the structured-output contract. */
  jsonSchemaSha256: hash,
  promptVersion: z.string(),
  schemaVersion: z.string(),
  variant: z.enum(CONTEXT_VARIANTS),
  model: z.string(),
  maxTokens: z.number().int().positive(),
  reasoningEffort: z.string().nullable(),
  privacy: z.string(),
});
export type CacheKeyParts = z.infer<typeof cacheKeyPartsSchema>;

/** Hash of any JSON value with sorted keys. */
export function contentHash(value: unknown): string {
  return sha256(canonical(value));
}

export function cacheKey(parts: CacheKeyParts): string {
  return sha256(canonical({ format: CACHE_FORMAT, ...parts }));
}

export const cacheEntrySchema = z.object({
  format: z.literal(CACHE_FORMAT),
  key: z.string(),
  parts: cacheKeyPartsSchema,
  createdAt: z.string(),
  response: proposalResponseSchema,
  meta: z.object({
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
  }),
});
export type CacheEntry = z.infer<typeof cacheEntrySchema>;

export type CacheRead =
  | { status: "hit"; entry: CacheEntry; response: ProposalResponse }
  | { status: "miss" }
  | { status: "corrupt"; reason: string };

/** Validates a stored entry against the key it should have. */
export function decodeCacheEntry(data: unknown, parts: CacheKeyParts): CacheRead {
  const key = cacheKey(parts);
  const parsed = cacheEntrySchema.safeParse(data);
  if (!parsed.success) return { status: "corrupt", reason: "does not match the cache format" };
  if (parsed.data.key !== key || cacheKey(parsed.data.parts) !== key) {
    return { status: "corrupt", reason: "key does not match its contents" };
  }
  return { status: "hit", entry: parsed.data, response: parsed.data.response };
}

export async function readCache(dir: string, parts: CacheKeyParts): Promise<CacheRead> {
  const key = cacheKey(parts);
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
  return decodeCacheEntry(data, parts);
}

export async function writeCache(
  dir: string,
  entry: Omit<CacheEntry, "format" | "key">,
): Promise<string> {
  const key = cacheKey(entry.parts);
  const full: CacheEntry = { format: CACHE_FORMAT, key, ...entry };
  cacheEntrySchema.parse(full);
  await writeJsonAtomic(join(dir, `${key}.json`), full);
  return key;
}

/**
 * Where validated discovery responses are kept. Refusals are optional: the web
 * backend remembers them so a declined episode is not sent again.
 */
export interface DiscoveryCacheStore {
  read(parts: CacheKeyParts): Promise<CacheRead>;
  write(entry: Omit<CacheEntry, "format" | "key">): Promise<string>;
  readRefusal?(parts: CacheKeyParts): Promise<string | null>;
  writeRefusal?(parts: CacheKeyParts, kind: string): Promise<void>;
}

export function fileDiscoveryCache(dir: string): DiscoveryCacheStore {
  return { read: (parts) => readCache(dir, parts), write: (entry) => writeCache(dir, entry) };
}
