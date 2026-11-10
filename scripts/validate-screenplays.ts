/**
 * Validates a screenplay ZIP and prints aggregate statistics and diagnostics.
 * Never prints screenplay text, loglines, or names.
 *
 * Usage:     npm run screenplays:validate -- <archive.zip> [--all]
 * Exit code: 0 valid, 1 invalid input, 2 usage or read error.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";

import type { Diagnostic } from "../src/domain/screenplay/diagnostics.ts";
import { countDiagnostics, summarizeShow } from "../src/domain/screenplay/summary.ts";
import { formatTimecode } from "../src/domain/screenplay/timecode.ts";
import { ingestScreenplayZip } from "../src/server/ingest/ingest.ts";
import { formatBytes } from "../src/server/ingest/zip.ts";

const USAGE = "Usage: npm run screenplays:validate -- <archive.zip> [--all]";
const MAX_REFS = 3;

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const inputs = args.filter((arg) => !arg.startsWith("--"));
const unknownFlags = args.filter((arg) => arg.startsWith("--") && arg !== "--all");

if (inputs.length !== 1 || unknownFlags.length > 0) {
  console.error(USAGE);
  process.exit(2);
}
const archivePath = inputs[0] ?? "";

let archive: Buffer;
try {
  archive = await readFile(archivePath);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
  console.error(`Cannot read ${archivePath} (${code}).`);
  process.exit(2);
}

const started = performance.now();
const result = await ingestScreenplayZip(archive, { archiveName: basename(archivePath) });
const elapsedMs = performance.now() - started;

const out: string[] = ["PromoLens screenplay check", ""];
const row = (label: string, value: string) => out.push(`  ${label.padEnd(12)} ${value}`);
const count = (n: number) => n.toLocaleString("en-US");

row("Archive", `${formatBytes(archive.length)}, ${result.sources.length} screenplay files`);
if (result.show) {
  const summary = summarizeShow(result.show);
  const kinds = Object.entries(summary.eventsByKind)
    .map(([kind, n]) => `${kind} ${count(n)}`)
    .join(", ");
  row("Episodes", `${summary.episodes} (${summary.firstEpisode} to ${summary.lastEpisode})`);
  row("Scenes", count(summary.scenes));
  row("Events", `${count(summary.events)}: ${kinds}`);
  row(
    "Screen time",
    `${formatTimecode(summary.totalDurationMs)} total, ` +
      `${formatTimecode(summary.shortestEpisodeMs)} to ${formatTimecode(summary.longestEpisodeMs)} per episode`,
  );
  row("Speakers", `${summary.speakerLabels} distinct labels (aliases are not merged)`);
}
row("Parsed in", `${Math.round(elapsedMs)} ms`);

const { bySeverity, byCode } = countDiagnostics(result.diagnostics);
out.push(
  "",
  `Diagnostics: ${bySeverity.error} errors, ${bySeverity.warning} warnings, ${bySeverity.info} info`,
);

const severityRank = { error: 0, warning: 1, info: 2 } as const;
const groups = [...byCode.entries()].sort(
  ([codeA, [a]], [codeB, [b]]) =>
    severityRank[a?.severity ?? "info"] - severityRank[b?.severity ?? "info"] ||
    codeA.localeCompare(codeB),
);

for (const [code, items] of groups) {
  const [first] = items;
  if (!first) continue;
  out.push("", `  ${first.severity.padEnd(8)} ${code} (${items.length})`);
  if (showAll) {
    for (const item of items) out.push(`           ${where(item)}  ${item.message}`);
    continue;
  }
  out.push(`           ${first.message}`);
  const refs = items.slice(0, MAX_REFS).map(where);
  const more = items.length > MAX_REFS ? `, and ${items.length - MAX_REFS} more` : "";
  out.push(`           at ${refs.join(", ")}${more}`);
}

out.push(
  "",
  result.ok
    ? "Result: valid."
    : `Result: invalid. Fix the ${bySeverity.error} error(s) above and run again.`,
);
if (!showAll && result.diagnostics.length > 0) out.push("Run with --all to list every diagnostic.");
console.log(out.join("\n"));
process.exit(result.ok ? 0 : 1);

function where(item: Diagnostic): string {
  const file = item.file ? (item.file.split("/").at(-1) ?? item.file) : "archive";
  return item.line ? `${file}:${item.line}` : file;
}
