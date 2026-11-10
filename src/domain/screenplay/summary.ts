import type { Diagnostic, DiagnosticCode, Severity } from "./diagnostics.ts";
import { EVENT_KINDS, type EventKind, type Show } from "./schema.ts";

export type ShowSummary = {
  episodes: number;
  firstEpisode: number;
  lastEpisode: number;
  scenes: number;
  events: number;
  eventsByKind: Record<EventKind, number>;
  totalDurationMs: number;
  shortestEpisodeMs: number;
  longestEpisodeMs: number;
  /** Distinct raw speaker labels. Aliases of one character count separately. */
  speakerLabels: number;
};

/** Aggregate counts only. Contains no screenplay text or names. */
export function summarizeShow(show: Show): ShowSummary {
  const eventsByKind = Object.fromEntries(EVENT_KINDS.map((kind) => [kind, 0])) as Record<
    EventKind,
    number
  >;
  const speakers = new Set<string>();
  let events = 0;
  let scenes = 0;

  for (const episode of show.episodes) {
    scenes += episode.scenes.length;
    for (const event of episode.events) {
      events += 1;
      eventsByKind[event.kind] += 1;
      if (event.speaker) speakers.add(event.speaker);
    }
  }

  const durations = show.episodes.map((episode) => episode.durationMs);
  return {
    episodes: show.episodes.length,
    firstEpisode: show.episodes[0]?.number ?? 0,
    lastEpisode: show.episodes.at(-1)?.number ?? 0,
    scenes,
    events,
    eventsByKind,
    totalDurationMs: durations.reduce((sum, ms) => sum + ms, 0),
    shortestEpisodeMs: Math.min(...durations),
    longestEpisodeMs: Math.max(...durations),
    speakerLabels: speakers.size,
  };
}

export function countDiagnostics(diagnostics: readonly Diagnostic[]) {
  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  const byCode = new Map<DiagnosticCode, Diagnostic[]>();
  for (const item of diagnostics) {
    bySeverity[item.severity] += 1;
    byCode.set(item.code, [...(byCode.get(item.code) ?? []), item]);
  }
  return { bySeverity, byCode };
}
