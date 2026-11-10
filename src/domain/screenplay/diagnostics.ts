import { z } from "zod";

/**
 * Every problem the ingestion pipeline can report, with a fixed severity.
 *
 * - error: part of the input could not be represented faithfully. Ingestion
 *   fails and nothing downstream may use the result.
 * - warning: the input is unusual or was repaired in a documented way. Source
 *   values are never changed to hide the problem.
 * - info: a normal variation worth knowing about, such as overlapping dialogue.
 *
 * Messages never contain screenplay text, only positions, times, and counts.
 */
export const SEVERITIES = ["error", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const DIAGNOSTIC_SEVERITY = {
  // Archive
  "invalid-archive": "error",
  "archive-too-large": "error",
  "too-many-entries": "error",
  "entry-too-large": "error",
  "uncompressed-too-large": "error",
  "unsafe-entry-path": "error",
  "unsafe-entry": "error",
  "unsupported-entry": "error",
  "duplicate-entry": "error",
  "corrupt-entry": "error",
  "no-screenplays": "error",
  "skipped-file": "info",
  // File
  "empty-file": "error",
  "invalid-encoding": "error",
  "unsupported-encoding": "error",
  "binary-content": "error",
  // Episode structure
  "missing-episode-number": "error",
  "episode-number-from-filename": "warning",
  "episode-number-mismatch": "warning",
  "missing-script-start": "warning",
  "missing-script-end": "warning",
  "content-after-script-end": "warning",
  "duplicate-header-field": "warning",
  "unrecognized-line": "warning",
  "no-scenes": "error",
  // Scenes
  "missing-scene-heading": "warning",
  "duplicate-scene-field": "warning",
  "scene-time-missing": "error",
  "scene-time-derived": "warning",
  "empty-scene": "warning",
  "scene-number-sequence": "warning",
  "scene-out-of-order": "warning",
  "scene-overlap": "warning",
  "scene-gap": "info",
  // Events
  "event-before-first-scene": "error",
  "invalid-label": "error",
  "missing-timing": "error",
  "invalid-timestamp": "error",
  "reversed-time-range": "error",
  "unexpected-timing-line": "warning",
  "timing-after-text": "warning",
  "missing-event-text": "warning",
  "zero-length-event": "warning",
  "event-outside-scene": "warning",
  "event-out-of-order": "warning",
  "dialogue-overlap": "info",
  "camera-overlap": "info",
  "dialogue-not-quoted": "info",
  // Show
  "duplicate-episode": "error",
  "duplicate-id": "error",
  "schema-violation": "error",
  "episode-number-gap": "warning",
} as const satisfies Record<string, Severity>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_SEVERITY;

const DIAGNOSTIC_CODES = Object.keys(DIAGNOSTIC_SEVERITY) as [DiagnosticCode, ...DiagnosticCode[]];

export const diagnosticSchema = z.object({
  severity: z.enum(SEVERITIES),
  code: z.enum(DIAGNOSTIC_CODES),
  message: z.string().min(1),
  /** Path of the file inside the archive. */
  file: z.string().optional(),
  episode: z.number().int().positive().optional(),
  /** 1-based line in the source file. */
  line: z.number().int().positive().optional(),
  /** Scene or event id. */
  ref: z.string().optional(),
});

export type Diagnostic = z.infer<typeof diagnosticSchema>;

export type DiagnosticLocation = Pick<Diagnostic, "file" | "episode" | "line" | "ref">;

export function diagnostic(
  code: DiagnosticCode,
  message: string,
  where: DiagnosticLocation = {},
): Diagnostic {
  return { severity: DIAGNOSTIC_SEVERITY[code], code, message, ...where };
}

/** Stable order: by file, then line, then code, then reference. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    compareText(a.file ?? "", b.file ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    compareText(a.code, b.code) ||
    compareText(a.ref ?? "", b.ref ?? "") ||
    compareText(a.message, b.message)
  );
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/** Code point order. Independent of locale, so results are the same on every machine. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
