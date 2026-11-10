import { compareText, diagnostic, type Diagnostic } from "./diagnostics.ts";
import type { EpisodeParseResult } from "./parse-episode.ts";
import type { Episode, Show } from "./schema.ts";

/**
 * Combines parsed episodes into one show, sorted by episode number.
 * Rejects duplicate episode numbers and repeated ids, and warns about gaps.
 */
export function assembleShow(
  title: string,
  results: readonly EpisodeParseResult[],
): { show: Show | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const parsed = results
    .flatMap((result) => (result.episode ? [result.episode] : []))
    .sort((a, b) => a.number - b.number || compareText(a.sourceFile, b.sourceFile));

  const episodes: Episode[] = [];
  for (const episode of parsed) {
    const first = episodes.find((kept) => kept.number === episode.number);
    if (first) {
      diagnostics.push(
        diagnostic(
          "duplicate-episode",
          `Episode ${episode.number} also comes from ${first.sourceFile}. Episode numbers must be unique.`,
          { file: episode.sourceFile, episode: episode.number },
        ),
      );
      continue;
    }
    episodes.push(episode);
  }

  const missing = missingNumbers(episodes.map((episode) => episode.number));
  if (missing.length > 0) {
    diagnostics.push(
      diagnostic("episode-number-gap", `Episode numbers are missing: ${formatRanges(missing)}.`),
    );
  }

  const seen = new Set<string>();
  for (const episode of episodes) {
    const ids = [
      episode.id,
      ...episode.scenes.map((s) => s.id),
      ...episode.events.map((e) => e.id),
    ];
    for (const id of ids) {
      if (seen.has(id)) {
        diagnostics.push(
          diagnostic("duplicate-id", `Id ${id} is used more than once.`, {
            file: episode.sourceFile,
            episode: episode.number,
            ref: id,
          }),
        );
      }
      seen.add(id);
    }
  }

  return { show: episodes.length > 0 ? { title, episodes } : null, diagnostics };
}

function missingNumbers(sorted: number[]): number[] {
  const missing: number[] = [];
  for (let index = 1; index < sorted.length; index++) {
    for (let n = (sorted[index - 1] ?? 0) + 1; n < (sorted[index] ?? 0); n++) missing.push(n);
  }
  return missing;
}

/** [3, 4, 5, 9] becomes "3-5, 9". */
export function formatRanges(numbers: number[]): string {
  const ranges: string[] = [];
  let start = numbers[0];
  let previous = start;
  for (const n of [...numbers.slice(1), undefined]) {
    if (n !== undefined && previous !== undefined && n === previous + 1) {
      previous = n;
      continue;
    }
    if (start !== undefined) ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = n;
    previous = n;
  }
  return ranges.join(", ");
}
