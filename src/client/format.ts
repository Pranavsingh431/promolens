import { formatTimecode } from "@/domain/screenplay/timecode";

/** Display helpers. Source times stay integer milliseconds; only these strings are derived. */

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatRange(startMs: number, endMs: number): string {
  return `${formatTimecode(startMs)} to ${formatTimecode(endMs)}`;
}

export function joinClasses(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
