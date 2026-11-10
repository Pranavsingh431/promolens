import { crc32 } from "node:zlib";

import yauzl, { type Entry, type ZipFile } from "yauzl";

import { diagnostic, type Diagnostic } from "../../domain/screenplay/diagnostics.ts";
import { MAX_ARCHIVE_BYTES } from "../../domain/screenplay/limits.ts";

/**
 * Reads text files from a ZIP held in memory. Nothing is written to disk.
 *
 * Safety rules:
 * - Size and count limits are checked against the declared sizes before
 *   decompressing, and against the real byte count while decompressing, so a
 *   ZIP bomb stops at the limit.
 * - Absolute paths, ".." segments, control characters, symbolic links,
 *   encrypted entries, and unknown compression methods reject the archive.
 * - Every entry is checked against its CRC-32.
 * - Hidden files, macOS metadata, and non-text files are skipped and reported.
 */

export type ZipLimits = {
  /** Size of the ZIP file itself. */
  maxArchiveBytes: number;
  /** Entries listed in the archive, including folders and skipped files. */
  maxEntries: number;
  /** Uncompressed size of one text file. */
  maxEntryBytes: number;
  /** Uncompressed size of all text files together. */
  maxTotalBytes: number;
};

const MB = 1024 * 1024;

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxArchiveBytes: MAX_ARCHIVE_BYTES,
  maxEntries: 1000,
  maxEntryBytes: 2 * MB,
  maxTotalBytes: 50 * MB,
};

export type ZipTextFile = { path: string; bytes: Uint8Array };

export type ZipReadResult =
  { ok: true; files: ZipTextFile[]; skipped: Diagnostic[] } | { ok: false; diagnostic: Diagnostic };

const TEXT_EXTENSIONS = new Set(["", ".txt", ".text", ".md"]);
const UNIX_HOST = 3;
const FILE_TYPE_MASK = 0o170000;
const SYMLINK_TYPE = 0o120000;

class ArchiveProblem extends Error {
  diagnostic: Diagnostic;

  constructor(problem: Diagnostic) {
    super(problem.message);
    this.diagnostic = problem;
  }
}

function problem(...args: Parameters<typeof diagnostic>): ArchiveProblem {
  return new ArchiveProblem(diagnostic(...args));
}

export async function readZipArchive(
  archive: Uint8Array,
  overrides: Partial<ZipLimits> = {},
): Promise<ZipReadResult> {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...overrides };

  if (archive.length === 0) {
    return { ok: false, diagnostic: diagnostic("invalid-archive", "The archive is empty.") };
  }
  if (archive.length > limits.maxArchiveBytes) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "archive-too-large",
        `Archive is ${formatBytes(archive.length)}; the limit is ${formatBytes(limits.maxArchiveBytes)}.`,
      ),
    };
  }

  let zip: ZipFile;
  try {
    zip = await yauzl.fromBufferPromise(
      Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength),
      { decodeStrings: true, validateEntrySizes: true, strictFileNames: false },
    );
  } catch {
    return {
      ok: false,
      diagnostic: diagnostic("invalid-archive", "File is not a readable ZIP archive."),
    };
  }

  try {
    if (zip.entryCount > limits.maxEntries) {
      throw problem(
        "too-many-entries",
        `Archive lists ${zip.entryCount} entries; the limit is ${limits.maxEntries}.`,
      );
    }
    const result = await readEntries(zip, limits);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, diagnostic: toDiagnostic(error) };
  } finally {
    zip.close();
  }
}

async function readEntries(zip: ZipFile, limits: ZipLimits) {
  const files: ZipTextFile[] = [];
  const skipped: Diagnostic[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for await (const entry of zip.eachEntry()) {
    const path = entry.fileName;
    if (/[\u0000-\u001f\u007f]/.test(path) || path.split("/").includes("..")) {
      throw problem("unsafe-entry-path", "Archive contains an unsafe file path.");
    }
    if (seen.has(path)) {
      throw problem("duplicate-entry", "Archive contains the same path twice.", { file: path });
    }
    seen.add(path);

    if (path.endsWith("/")) continue;
    if (isSymlink(entry)) {
      throw problem("unsafe-entry", "Archive contains a symbolic link.", { file: path });
    }
    if (isHiddenOrSystem(path)) {
      skipped.push(
        diagnostic("skipped-file", "Hidden or system file was skipped.", { file: path }),
      );
      continue;
    }
    if (!TEXT_EXTENSIONS.has(extensionOf(path))) {
      skipped.push(diagnostic("skipped-file", "Not a text file; skipped.", { file: path }));
      continue;
    }
    if (entry.isEncrypted()) {
      throw problem("unsupported-entry", "Encrypted files are not supported.", { file: path });
    }
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      throw problem("unsupported-entry", "File uses an unsupported compression method.", {
        file: path,
      });
    }
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      throw problem(
        "entry-too-large",
        `File is ${formatBytes(entry.uncompressedSize)} uncompressed; the limit is ${formatBytes(limits.maxEntryBytes)}.`,
        { file: path },
      );
    }
    if (totalBytes + entry.uncompressedSize > limits.maxTotalBytes) {
      throw problem(
        "uncompressed-too-large",
        `Text files exceed ${formatBytes(limits.maxTotalBytes)} uncompressed.`,
        { file: path },
      );
    }

    const bytes = await readEntry(zip, entry, limits.maxEntryBytes);
    if (crc32(bytes) !== entry.crc32) {
      throw problem("corrupt-entry", "File data does not match its checksum.", { file: path });
    }
    totalBytes += bytes.length;
    files.push({ path, bytes });
  }
  return { files, skipped };
}

async function readEntry(zip: ZipFile, entry: Entry, maxBytes: number): Promise<Uint8Array> {
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) {
        throw problem("entry-too-large", `File expands past ${formatBytes(maxBytes)}.`, {
          file: entry.fileName,
        });
      }
      chunks.push(chunk);
    }
  } catch (error) {
    stream.destroy();
    if (error instanceof ArchiveProblem) throw error;
    throw problem("corrupt-entry", "File data is damaged or does not match its declared size.", {
      file: entry.fileName,
    });
  }
  return Buffer.concat(chunks, size);
}

function toDiagnostic(error: unknown): Diagnostic {
  if (error instanceof ArchiveProblem) return error.diagnostic;
  const message = error instanceof Error ? error.message : "";
  if (/absolute path|invalid relative path|invalid characters in fileName/i.test(message)) {
    return diagnostic("unsafe-entry-path", "Archive contains an unsafe file path.");
  }
  return diagnostic("invalid-archive", "Archive structure is damaged or unsupported.");
}

function isSymlink(entry: Entry): boolean {
  return (
    entry.versionMadeBy >>> 8 === UNIX_HOST &&
    ((entry.externalFileAttributes >>> 16) & FILE_TYPE_MASK) === SYMLINK_TYPE
  );
}

function isHiddenOrSystem(path: string): boolean {
  return path.split("/").some((part) => part.startsWith(".") || part === "__MACOSX");
}

function extensionOf(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}
