import { createHash } from "node:crypto";

import { assembleShow } from "../../domain/screenplay/assemble-show.ts";
import { decodeScreenplayBytes, looksLikeScreenplay } from "../../domain/screenplay/decode.ts";
import {
  compareDiagnostics,
  compareText,
  diagnostic,
  hasErrors,
  type Diagnostic,
} from "../../domain/screenplay/diagnostics.ts";
import { parseEpisode, type EpisodeParseResult } from "../../domain/screenplay/parse-episode.ts";
import { showSchema, type Show } from "../../domain/screenplay/schema.ts";
import { readZipArchive, type ZipLimits } from "./zip.ts";

export type InputFile = { path: string; bytes: Uint8Array };

/** Where each episode came from. The hash identifies the exact source bytes. */
export type SourceFile = { path: string; bytes: number; sha256: string };

/**
 * When ok is false, show is a best-effort partial result for reporting only.
 * Analysis must not run on it.
 */
export type IngestResult =
  | { ok: true; show: Show; diagnostics: Diagnostic[]; sources: SourceFile[] }
  | { ok: false; show: Show | null; diagnostics: Diagnostic[]; sources: SourceFile[] };

export type IngestOptions = {
  /** Show title. Defaults to the folder that holds every episode file, then to fallbackTitle. */
  title?: string;
  fallbackTitle?: string;
};

export async function ingestScreenplayZip(
  archive: Uint8Array,
  options: IngestOptions & { limits?: Partial<ZipLimits>; archiveName?: string } = {},
): Promise<IngestResult> {
  const read = await readZipArchive(archive, options.limits);
  if (!read.ok) return { ok: false, show: null, diagnostics: [read.diagnostic], sources: [] };

  const fallbackTitle = options.archiveName?.replace(/\.zip$/i, "");
  const result = ingestScreenplayFiles(read.files, {
    ...(options.title ? { title: options.title } : {}),
    ...(fallbackTitle ? { fallbackTitle } : {}),
  });
  const diagnostics = [...read.skipped, ...result.diagnostics].sort(compareDiagnostics);
  return { ...result, diagnostics };
}

/** Parses already-extracted files. The result does not depend on the order of `files`. */
export function ingestScreenplayFiles(
  files: readonly InputFile[],
  options: IngestOptions = {},
): IngestResult {
  const diagnostics: Diagnostic[] = [];
  const sources: SourceFile[] = [];
  const parsed: EpisodeParseResult[] = [];

  for (const file of [...files].sort((a, b) => compareText(a.path, b.path))) {
    const decoded = decodeScreenplayBytes(file.bytes);
    if (!decoded.ok) {
      diagnostics.push(diagnostic(decoded.code, decoded.message, { file: file.path }));
      continue;
    }
    if (decoded.text.trim() === "") {
      diagnostics.push(diagnostic("empty-file", "File is empty.", { file: file.path }));
      continue;
    }
    if (!looksLikeScreenplay(decoded.text)) {
      diagnostics.push(
        diagnostic("skipped-file", "File is not a timestamped screenplay; skipped.", {
          file: file.path,
        }),
      );
      continue;
    }
    sources.push({ path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes) });
    const result = parseEpisode({ path: file.path, text: decoded.text });
    parsed.push(result);
    diagnostics.push(...result.diagnostics);
  }

  if (parsed.length === 0) {
    diagnostics.push(diagnostic("no-screenplays", "No timestamped screenplay files were found."));
  }

  const title =
    options.title ??
    commonFolder(sources.map((source) => source.path)) ??
    options.fallbackTitle ??
    "Untitled show";
  const assembled = assembleShow(title, parsed);
  diagnostics.push(...assembled.diagnostics);

  const { show } = assembled;
  if (show) {
    const check = showSchema.safeParse(show);
    if (!check.success) {
      const issue = check.error.issues[0];
      diagnostics.push(
        diagnostic(
          "schema-violation",
          `Parsed data breaks the canonical schema at ${issue?.path.join(".") ?? "unknown path"}: ${issue?.message ?? "unknown"}.`,
        ),
      );
    }
  }

  diagnostics.sort(compareDiagnostics);
  return show && !hasErrors(diagnostics)
    ? { ok: true, show, diagnostics, sources }
    : { ok: false, show, diagnostics, sources };
}

function commonFolder(paths: string[]): string | undefined {
  const folders = new Set(paths.map((path) => (path.includes("/") ? path.split("/")[0] : "")));
  const [only] = folders;
  return folders.size === 1 && only ? only : undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
