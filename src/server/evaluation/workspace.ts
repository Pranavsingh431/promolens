import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { z } from "zod";

import {
  readAnnotationFile,
  type AnnotationFile,
  type AnnotationIssue,
} from "../../domain/evaluation/annotation.ts";
import type { Show } from "../../domain/screenplay/schema.ts";
import { createTimeline, type Timeline } from "../../domain/screenplay/timeline.ts";
import { ingestScreenplayZip } from "../ingest/ingest.ts";
import { writeJsonAtomic } from "../write-json-atomic.ts";

export { writeJsonAtomic };

/**
 * Files used by the evaluation commands. Everything lives in one directory,
 * by default private/evaluation, which git and Vercel ignore because it holds
 * screenplay-derived data and human annotations.
 */

export const DEFAULT_EVALUATION_DIR = "private/evaluation";

export function workspacePaths(dir: string) {
  return {
    dir,
    sample: join(dir, "sample.json"),
    candidates: (method: string) => join(dir, "candidates", `${method}.json`),
    candidatesDir: join(dir, "candidates"),
    reviewItems: join(dir, "review", "items.json"),
    reviewKey: join(dir, "review", "key.json"),
    annotationsDir: join(dir, "annotations"),
    annotation: (reviewer: string) => join(dir, "annotations", `${reviewer}.json`),
    reportsDir: join(dir, "reports"),
    heldOutLog: join(dir, "reports", "held-out-runs.log"),
  };
}

export class WorkspaceError extends Error {}

export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new WorkspaceError(`Missing ${path}. Run the earlier evaluation step first.`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new WorkspaceError(`${path} is not valid JSON.`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new WorkspaceError(
      `${path} is invalid at ${issue?.path.join(".") || "root"}: ${issue?.message}`,
    );
  }
  return parsed.data;
}

/** Writes JSON through a temporary file and a rename, so a crash never leaves half a file. */

export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

export type LoadedPack = { show: Show; timeline: Timeline; packSha256: string };

export async function loadPack(zipPath: string): Promise<LoadedPack> {
  let archive: Buffer;
  try {
    archive = await readFile(zipPath);
  } catch {
    throw new WorkspaceError(`Cannot read ${zipPath}.`);
  }
  const result = await ingestScreenplayZip(archive);
  if (!result.ok) {
    const errors = result.diagnostics.filter((d) => d.severity === "error").length;
    throw new WorkspaceError(
      `The pack has ${errors} error(s). Run npm run screenplays:validate on it for details.`,
    );
  }
  return {
    show: result.show,
    timeline: createTimeline(result.show),
    packSha256: createHash("sha256").update(archive).digest("hex"),
  };
}

/** Refuses to mix files from different screenplay packs. */
export function assertSamePack(expected: string, actual: string, what: string): void {
  if (expected !== actual) {
    throw new WorkspaceError(
      `${what} was made from a different screenplay pack (sha256 ${expected.slice(0, 12)}, now ${actual.slice(0, 12)}).`,
    );
  }
}

export async function readAnnotationFiles(dir: string): Promise<{
  files: AnnotationFile[];
  problems: Array<{ path: string; issues: AnnotationIssue[] }>;
}> {
  const { annotationsDir } = workspacePaths(dir);
  let names: string[] = [];
  try {
    names = (await readdir(annotationsDir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return { files: [], problems: [] };
  }
  const files: AnnotationFile[] = [];
  const problems: Array<{ path: string; issues: AnnotationIssue[] }> = [];
  for (const name of names) {
    const path = join(annotationsDir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch {
      problems.push({
        path,
        issues: [{ severity: "error", path: "", message: "Not valid JSON." }],
      });
      continue;
    }
    const read = readAnnotationFile(raw);
    if (!read.ok) {
      problems.push({ path, issues: read.issues });
      continue;
    }
    if (`${read.file.reviewer}.json` !== name) {
      problems.push({
        path,
        issues: [
          {
            severity: "error",
            path: "reviewer",
            message: "Reviewer code does not match the file name.",
          },
        ],
      });
      continue;
    }
    files.push(read.file);
  }
  return { files, problems };
}
