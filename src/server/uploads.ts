import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { JobFailureCode } from "../domain/analysis-job.ts";
import { MAX_ARCHIVE_BYTES } from "../domain/screenplay/limits.ts";
import { normalizedShowHash } from "./analysis/identity.ts";
import { ApiError } from "./api-error.ts";
import type { Backend } from "./backend.ts";
import { shows, uploads } from "./db/schema.ts";
import { ingestScreenplayZip } from "./ingest/ingest.ts";
import type { ShowRow } from "./jobs.ts";
import { logEvent } from "./log.ts";

/**
 * Bringing a screenplay ZIP in. A file becomes a show only after the server
 * has read it from private storage and run the full ingest on it, including
 * every archive safety check. Nothing the browser says about a file is trusted.
 */

export const UPLOAD_MINUTES = 15;

export const createUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  sizeBytes: z.number().int().positive(),
});

const cleanName = (name: string) =>
  name
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/[^\p{L}\p{N} ._()-]+/gu, "-")
    .slice(0, 200) || "show.zip";

export type UploadRow = typeof uploads.$inferSelect;

export async function createUpload(
  backend: Backend,
  ownerId: string,
  input: z.infer<typeof createUploadSchema>,
): Promise<UploadRow> {
  if (input.sizeBytes > MAX_ARCHIVE_BYTES) {
    throw new ApiError(413, "too-large", "This file is over the upload limit.");
  }
  if (!/\.zip$/i.test(input.fileName)) {
    throw new ApiError(415, "invalid-archive", "Choose a file ending in .zip.");
  }
  const id = randomUUID();
  const [row] = await backend.db
    .insert(uploads)
    .values({
      id,
      ownerId,
      fileName: cleanName(input.fileName),
      declaredBytes: input.sizeBytes,
      // Made only from ids the server generated, so a client cannot aim it anywhere else.
      storageKey: `uploads/${ownerId}/${id}/source.zip`,
      expiresAt: new Date(Date.now() + UPLOAD_MINUTES * 60_000),
    })
    .returning();
  if (!row) throw new Error("Could not record the upload.");
  return row;
}

export async function findOpenUpload(
  backend: Backend,
  ownerId: string,
  uploadId: string,
): Promise<UploadRow | null> {
  const [row] = await backend.db
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, uploadId), eq(uploads.ownerId, ownerId), eq(uploads.status, "open")))
    .limit(1);
  if (!row || row.expiresAt < new Date()) return null;
  return row;
}

export async function findOpenUploadByKey(
  backend: Backend,
  ownerId: string,
  storageKey: string,
): Promise<UploadRow | null> {
  const [row] = await backend.db
    .select()
    .from(uploads)
    .where(
      and(
        eq(uploads.storageKey, storageKey),
        eq(uploads.ownerId, ownerId),
        eq(uploads.status, "open"),
      ),
    )
    .limit(1);
  if (!row || row.expiresAt < new Date()) return null;
  return row;
}

/** Reads a request body, stopping as soon as it passes the limit. */
export async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) throw new ApiError(400, "invalid-archive", "The upload was empty.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > limit) throw new ApiError(413, "too-large", "This file is over the upload limit.");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function rejectionCode(codes: readonly string[]): JobFailureCode {
  if (codes.includes("no-screenplays")) return "no-episodes";
  if (
    codes.some(
      (c) => c === "archive-too-large" || c.endsWith("-too-large") || c === "too-many-entries",
    )
  ) {
    return "too-large";
  }
  if (
    codes.some((c) => /invalid-archive|unsafe|unsupported-entry|duplicate-entry|corrupt/.test(c))
  ) {
    return "invalid-archive";
  }
  return "unsupported-format";
}

const REJECTION_MESSAGE: Record<string, string> = {
  "no-episodes":
    "This ZIP contains no screenplay episodes. Upload the ZIP containing your timestamped episode scripts.",
  "too-large": "This ZIP is over one of the size limits.",
  "invalid-archive": "This file is not a ZIP that PromoLens can safely open.",
  "unsupported-format": "Some screenplays in this ZIP could not be read.",
};

export async function completeUpload(
  backend: Backend,
  ownerId: string,
  uploadId: string,
): Promise<{ show: ShowRow; duplicate: boolean }> {
  const upload = await findOpenUpload(backend, ownerId, uploadId);
  if (!upload) throw new ApiError(404, "not-found", "That upload was not found.");
  const { db, storage, config } = backend;

  const reject = async (status: number, code: JobFailureCode, message: string): Promise<never> => {
    await storage.delete([upload.storageKey]);
    await db.update(uploads).set({ status: "rejected" }).where(eq(uploads.id, upload.id));
    throw new ApiError(status, code, message);
  };

  // A storage problem says nothing about the file, so it stays in place for another try.
  const notChecked = (category: string) => {
    logEvent("upload.not-checked", { errorCategory: category });
    return new ApiError(503, "storage-unavailable", "This file could not be checked. Try again.");
  };
  const bytes = await storage.get(upload.storageKey).catch(() => {
    throw notChecked("read-failed");
  });
  if (!bytes) throw new ApiError(409, "storage-unavailable", "The file has not arrived yet.");
  const exposed = await Promise.resolve(storage.isPubliclyReadable?.(upload.storageKey)).catch(
    () => {
      throw notChecked("privacy-check-failed");
    },
  );
  if (exposed) {
    logEvent("upload.refused", { errorCategory: "storage-not-private" });
    return reject(503, "storage-unavailable", "This file could not be stored privately.");
  }
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    return reject(413, "too-large", "This file is over the upload limit.");
  }

  const ingested = await ingestScreenplayZip(bytes, { archiveName: upload.fileName });
  if (!ingested.ok) {
    const code = rejectionCode(
      ingested.diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
    );
    return reject(422, code, REJECTION_MESSAGE[code] ?? "This file could not be used.");
  }

  const contentSha256 = normalizedShowHash(ingested.show);
  const retained = new Date(Date.now() + config.limits.retentionDays * 86_400_000);
  const [created] = await db
    .insert(shows)
    .values({
      ownerId,
      title: ingested.show.title,
      fileName: upload.fileName,
      archiveSha256: createHash("sha256").update(bytes).digest("hex"),
      contentSha256,
      sizeBytes: bytes.length,
      storageKey: upload.storageKey,
      episodeCount: ingested.show.episodes.length,
      expiresAt: retained,
    })
    .onConflictDoNothing()
    .returning();
  await db.update(uploads).set({ status: "completed" }).where(eq(uploads.id, upload.id));
  if (created) return { show: created, duplicate: false };

  const [existing] = await db
    .select()
    .from(shows)
    .where(and(eq(shows.ownerId, ownerId), eq(shows.contentSha256, contentSha256)))
    .limit(1);
  if (!existing) throw new Error("Could not find the existing show.");
  // Two completions of one upload race to here. The loser must not delete the winner's file.
  if (existing.storageKey === upload.storageKey) return { show: existing, duplicate: false };
  // The same screenplays are already here, so this copy is not kept.
  await storage.delete([upload.storageKey]);
  return { show: existing, duplicate: true };
}
