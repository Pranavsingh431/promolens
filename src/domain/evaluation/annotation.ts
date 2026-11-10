import { z } from "zod";

import type { Timeline } from "../screenplay/timeline.ts";
import {
  DURATION_LIMITS,
  clipKey,
  intervalDurationMs,
  parseClipKey,
  type Interval,
} from "./candidate.ts";
import { RUBRIC_VERSION, judgmentSchema, type Judgment } from "./rubric.ts";
import type { ReviewItems } from "./review.ts";
import type { EvaluationSample } from "./sample.ts";

/**
 * Human annotations. One file per anonymous reviewer code, so several
 * reviewers' judgments of the same clip are kept apart.
 *
 * Part A holds moments a reviewer found while reading a whole episode.
 * Part B holds cold-viewer ratings of blind review items.
 *
 * Every record carries a version that the server bumps on each real change,
 * and the file carries a revision used to reject stale saves.
 */

export const ANNOTATION_SCHEMA_VERSION = 1;

export const reviewerCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]{2,12}$/, "Reviewer codes use 2 to 12 capital letters or digits.");

const isoTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Not a timestamp");

const intervalSchema = z
  .object({
    episode: z.number().int().positive(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
  })
  .refine((s) => s.endMs > s.startMs, { message: "Segment must end after it starts" });

export const momentSchema = z.object({
  id: z.string().regex(/^M-E\d{3,}-\d{2,}$/),
  segments: z.array(intervalSchema).min(1),
  judgment: judgmentSchema,
  version: z.number().int().positive(),
  updatedAt: isoTime,
});

export const clipReviewSchema = z.object({
  itemId: z.string().regex(/^B\d{3,}$/),
  clipKey: z.string(),
  judgment: judgmentSchema,
  version: z.number().int().positive(),
  updatedAt: isoTime,
});

export const annotationFileSchema = z.object({
  schemaVersion: z.literal(ANNOTATION_SCHEMA_VERSION),
  rubricVersion: z.string(),
  reviewer: reviewerCodeSchema,
  sampleVersion: z.string(),
  revision: z.number().int().nonnegative(),
  partA: z.array(
    z.object({
      episode: z.number().int().positive(),
      status: z.enum(["in-progress", "complete"]),
      moments: z.array(momentSchema),
    }),
  ),
  partB: z.array(clipReviewSchema),
});

export type Moment = z.infer<typeof momentSchema>;
export type ClipReview = z.infer<typeof clipReviewSchema>;
export type AnnotationFile = z.infer<typeof annotationFileSchema>;

export type AnnotationIssue = { severity: "error" | "warning"; path: string; message: string };

export function emptyAnnotationFile(reviewer: string, sampleVersion: string): AnnotationFile {
  return {
    schemaVersion: ANNOTATION_SCHEMA_VERSION,
    rubricVersion: RUBRIC_VERSION,
    reviewer,
    sampleVersion,
    revision: 0,
    partA: [],
    partB: [],
  };
}

/** Parses an annotation file and explains version problems in plain words. */
export function readAnnotationFile(
  raw: unknown,
): { ok: true; file: AnnotationFile } | { ok: false; issues: AnnotationIssue[] } {
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version === "number" && version > ANNOTATION_SCHEMA_VERSION) {
    return {
      ok: false,
      issues: [
        {
          severity: "error",
          path: "schemaVersion",
          message: `File uses annotation format ${version}, written by a newer PromoLens. This version reads format ${ANNOTATION_SCHEMA_VERSION}.`,
        },
      ],
    };
  }
  const parsed = annotationFileSchema.safeParse(raw);
  if (parsed.success) return { ok: true, file: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({
      severity: "error",
      path: i.path.join("."),
      message: i.message,
    })),
  };
}

/** Checks that an annotation file fits the sample, the screenplay, and the review items. */
export function validateAnnotations(
  file: AnnotationFile,
  context: { sample: EvaluationSample; timeline: Timeline; items: ReviewItems },
): AnnotationIssue[] {
  const issues: AnnotationIssue[] = [];
  const error = (path: string, message: string) =>
    issues.push({ severity: "error", path, message });
  const warn = (path: string, message: string) =>
    issues.push({ severity: "warning", path, message });

  if (file.sampleVersion !== context.sample.version) {
    error(
      "sampleVersion",
      `File belongs to sample ${file.sampleVersion}, not ${context.sample.version}.`,
    );
  }
  if (file.rubricVersion !== RUBRIC_VERSION) {
    warn(
      "rubricVersion",
      `Rated with rubric ${file.rubricVersion}; the current rubric is ${RUBRIC_VERSION}.`,
    );
  }

  const sampled = new Set(context.sample.episodes.map((e) => e.episode));
  const seenEpisodes = new Set<number>();
  const seenMoments = new Set<string>();
  file.partA.forEach((entry, i) => {
    const path = `partA.${i}`;
    if (!sampled.has(entry.episode)) error(path, `Episode ${entry.episode} is not in the sample.`);
    if (seenEpisodes.has(entry.episode)) error(path, `Episode ${entry.episode} appears twice.`);
    seenEpisodes.add(entry.episode);

    entry.moments.forEach((moment, j) => {
      const at = `${path}.moments.${j}`;
      if (seenMoments.has(moment.id)) error(at, `Moment id ${moment.id} repeats.`);
      seenMoments.add(moment.id);
      if (moment.segments.some((s) => s.episode !== entry.episode)) {
        error(at, "Part A moments must stay inside the episode being read.");
      }
      issues.push(...checkClip(moment.segments, context.timeline, at));
    });
  });

  const items = new Map(context.items.items.map((item) => [item.itemId, item.clipKey]));
  const seenItems = new Set<string>();
  file.partB.forEach((review, i) => {
    const path = `partB.${i}`;
    const expected = items.get(review.itemId);
    if (!expected) error(path, `Review item ${review.itemId} does not exist.`);
    else if (expected !== review.clipKey)
      error(path, `Review item ${review.itemId} points at a different clip.`);
    if (seenItems.has(review.itemId)) error(path, `Review item ${review.itemId} is rated twice.`);
    seenItems.add(review.itemId);
  });
  return issues;
}

/** Duration and bounds errors, plus warnings for edges that cut a spoken line. */
export function checkClip(
  segments: readonly Interval[],
  timeline: Timeline,
  path = "",
): AnnotationIssue[] {
  const issues: AnnotationIssue[] = [];
  const total = intervalDurationMs(segments);
  if (total < DURATION_LIMITS.minDurationMs || total > DURATION_LIMITS.maxDurationMs) {
    issues.push({
      severity: "error",
      path,
      message: `Clip runs ${(total / 1000).toFixed(1)} s; it must run 20 to 60 s.`,
    });
  }
  for (const segment of segments) {
    const check = timeline.checkSegment(segment);
    if (!check.ok) {
      issues.push({ severity: "error", path, message: `Segment is ${check.problems.join(", ")}.` });
      continue;
    }
    if (check.splitAtStart.some((e) => e.kind === "dialogue")) {
      issues.push({ severity: "warning", path, message: "Starts in the middle of a spoken line." });
    }
    if (check.splitAtEnd.some((e) => e.kind === "dialogue")) {
      issues.push({ severity: "warning", path, message: "Ends in the middle of a spoken line." });
    }
  }
  return issues;
}

type Versioned = { version: number; updatedAt: string };

/** JSON with object keys sorted, so key order never counts as a change. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameContent(a: Versioned, b: Versioned): boolean {
  const body = (record: Versioned) => canonicalJson({ ...record, version: 0, updatedAt: "" });
  return body(a) === body(b);
}

/**
 * Applies a save from the review tool. The client's versions and timestamps
 * are ignored: a record keeps its version when unchanged, gets version + 1
 * when changed, and starts at 1 when new. Part B clip keys always come from
 * the review items, never from the client.
 */
export function mergeAnnotationSave(
  existing: AnnotationFile,
  incoming: AnnotationFile,
  options: { baseRevision: number; now: string; items: ReviewItems },
): { ok: true; file: AnnotationFile } | { ok: false; conflict: true } {
  if (options.baseRevision !== existing.revision) return { ok: false, conflict: true };
  const itemKeys = new Map(options.items.items.map((item) => [item.itemId, item.clipKey]));

  const version = <T extends Versioned>(next: T, previous: T | undefined): T =>
    previous && sameContent(previous, next)
      ? { ...next, version: previous.version, updatedAt: previous.updatedAt }
      : { ...next, version: (previous?.version ?? 0) + 1, updatedAt: options.now };

  const oldMoments = new Map(existing.partA.flatMap((e) => e.moments).map((m) => [m.id, m]));
  const oldReviews = new Map(existing.partB.map((r) => [r.itemId, r]));

  return {
    ok: true,
    file: {
      ...incoming,
      schemaVersion: ANNOTATION_SCHEMA_VERSION,
      reviewer: existing.reviewer,
      sampleVersion: existing.sampleVersion,
      revision: existing.revision + 1,
      partA: incoming.partA.map((entry) => ({
        ...entry,
        moments: entry.moments.map((m) => version(m, oldMoments.get(m.id))),
      })),
      partB: incoming.partB.map((review) =>
        version(
          { ...review, clipKey: itemKeys.get(review.itemId) ?? review.clipKey },
          oldReviews.get(review.itemId),
        ),
      ),
    },
  };
}

export type JudgmentRecord = {
  reviewer: string;
  source: "part-a" | "part-b";
  clipKey: string;
  segments: Interval[];
  judgment: Judgment;
};

/** Flattens annotation files into one record per human judgment. Nothing is merged here. */
export function collectJudgments(files: readonly AnnotationFile[]) {
  const records: JudgmentRecord[] = [];
  const completeEpisodes: Array<{ reviewer: string; episode: number }> = [];
  for (const file of files) {
    for (const entry of file.partA) {
      if (entry.status === "complete")
        completeEpisodes.push({ reviewer: file.reviewer, episode: entry.episode });
      for (const moment of entry.moments) {
        records.push({
          reviewer: file.reviewer,
          source: "part-a",
          clipKey: clipKey(moment.segments),
          segments: moment.segments,
          judgment: moment.judgment,
        });
      }
    }
    for (const review of file.partB) {
      records.push({
        reviewer: file.reviewer,
        source: "part-b",
        clipKey: review.clipKey,
        segments: parseClipKey(review.clipKey),
        judgment: review.judgment,
      });
    }
  }
  return { records, completeEpisodes };
}
