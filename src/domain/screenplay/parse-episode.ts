import {
  compareDiagnostics,
  diagnostic,
  type Diagnostic,
  type DiagnosticLocation,
} from "./diagnostics.ts";
import type {
  Delivery,
  Episode,
  EventKind,
  Scene,
  ScreenplayEvent,
  WriterNotes,
} from "./schema.ts";
import { formatTimecode, parseTimecode } from "./timecode.ts";

/**
 * Deterministic parser for one timestamped episode file.
 *
 * Expected layout (labels are matched case-insensitively):
 *
 *   EPISODE NUMBER: Episode 3          header fields, before the script
 *   EPISODE LOGLINE: ...
 *   CONTINUITY NOTES: ...
 *   --- SCRIPT START ---
 *   SCENE 01
 *   Scene heading: INT. FERRY DECK - NIGHT
 *   Scene start: 00:00.00
 *   Scene end: 01:12.40
 *   Actions and dialogue:
 *   **CAMERA:**                        event label
 *   Start: (00:00.00) | End: (00:03.20)
 *   One or more lines of text.
 *   --- SCRIPT END ---
 *
 * The parser never reorders, merges, or retimes source data. Every repair or
 * dropped element is reported as a diagnostic with its line number.
 */

export type EpisodeSource = { path: string; text: string };
export type EpisodeParseResult = { episode: Episode | null; diagnostics: Diagnostic[] };

const SCRIPT_START = /^-{2,}\s*script\s+start\s*-{2,}$/i;
const SCRIPT_END = /^-{2,}\s*script\s+end\s*-{2,}$/i;
const SCENE_LINE = /^scene\s+(\d{1,4})\s*:?$/i;
const SCENE_FIELD = /^scene\s+(heading|start|end)\s*:\s*(.*)$/i;
const SCENE_BODY_MARKER = /^actions?\s+(?:and|&)\s+dialogues?\s*:?$/i;
const LABEL = /^\*\*(.+?):\*\*$|^\*\*(.+?)\*\*:$/;
const TIMING = /^start\s*:\s*(.*?)\s*\|\s*end\s*:\s*(.*)$/i;
const HEADER_FIELD = /^([A-Za-z][A-Za-z ]{0,40}?)\s*:\s*(.*)$/;

const HEADER_ROLES: Record<string, "number" | "logline" | "continuityNotes"> = {
  "EPISODE NUMBER": "number",
  "EPISODE NO": "number",
  EPISODE: "number",
  "EPISODE LOGLINE": "logline",
  LOGLINE: "logline",
  "CONTINUITY NOTES": "continuityNotes",
  CONTINUITY: "continuityNotes",
};

const STRUCTURAL_LABELS: Record<string, Exclude<EventKind, "dialogue">> = {
  CAMERA: "camera",
  "CAMERA ANGLE": "camera",
  SHOT: "camera",
  ACTION: "action",
  "SOUND FX": "sound",
  SFX: "sound",
  SOUND: "sound",
  "SOUND EFFECT": "sound",
  "SOUND EFFECTS": "sound",
  MUSIC: "sound",
};

const SETTING = /^(INT\.?\s*\/\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|I\/E\.?|INT\.?|EXT\.?)(?:\s+|$)(.*)$/i;
const LAST_SEPARATOR = /^(.*\S)\s+[-\u2013\u2014]\s+(.+)$/;
const TIME_OF_DAY =
  /^(DAY|NIGHT|MORNING|AFTERNOON|EVENING|DUSK|DAWN|SUNSET|SUNRISE|NOON|MIDNIGHT|LATER|MOMENTS LATER|CONTINUOUS|SAME|SAME TIME)\b/i;

type Field = { value: string; line: number };
type HeaderField = Field & { key: string };

type PendingBlock = {
  seq: number;
  line: number;
  endLine: number;
  label: string;
  timing?: { start: string; end: string; line: number };
  textLines: string[];
  textBeforeTiming: boolean;
};

type PendingScene = {
  ordinal: number;
  number: number;
  line: number;
  heading?: Field;
  start?: Field;
  end?: Field;
  blocks: PendingBlock[];
};

type Report = (
  code: Parameters<typeof diagnostic>[0],
  message: string,
  where?: Omit<DiagnosticLocation, "file">,
) => void;

export function parseEpisode(source: EpisodeSource): EpisodeParseResult {
  const diagnostics: Diagnostic[] = [];
  const report: Report = (code, message, where = {}) => {
    diagnostics.push(diagnostic(code, message, { file: source.path, ...where }));
  };

  if (source.text.trim() === "") {
    report("empty-file", "File is empty.");
    return { episode: null, diagnostics };
  }

  const { headerFields, scenes } = readStructure(source.text, report);
  const { numberField, writerNotes } = readHeader(headerFields, report);
  const number = resolveEpisodeNumber(numberField, source.path, report);

  if (scenes.length === 0) report("no-scenes", "No scenes were found.");
  if (number === undefined || scenes.length === 0) {
    return { episode: null, diagnostics: diagnostics.sort(compareDiagnostics) };
  }

  const episode = buildEpisode(number, source.path, writerNotes, scenes, report);
  for (const item of diagnostics) item.episode ??= number;
  return { episode, diagnostics: diagnostics.sort(compareDiagnostics) };
}

/** Single pass over the lines. Collects raw structure; no timestamps are interpreted here. */
function readStructure(text: string, report: Report) {
  const lines = text.split(/\r\n|\r|\n/);
  const headerFields: HeaderField[] = [];
  const scenes: PendingScene[] = [];
  let section: "header" | "script" | "after" = "header";
  let sawStart = false;
  let block: PendingBlock | undefined;
  let blockCount = 0;
  let afterEnd = { count: 0, firstLine: 0 };

  for (const [index, rawLine] of lines.entries()) {
    const line = index + 1;
    const content = rawLine.trim();

    if (section === "after") {
      if (content) afterEnd = { count: afterEnd.count + 1, firstLine: afterEnd.firstLine || line };
      continue;
    }

    if (section === "header") {
      if (!content) continue;
      if (SCRIPT_START.test(content)) {
        section = "script";
        sawStart = true;
        continue;
      }
      if (!SCENE_LINE.test(content)) {
        readHeaderLine(content, line, headerFields, report);
        continue;
      }
      // A scene without a start marker. Handle this line as script.
      section = "script";
    }

    if (!content) continue;

    if (SCRIPT_END.test(content)) {
      section = "after";
      block = undefined;
      continue;
    }
    if (SCRIPT_START.test(content)) {
      report("unrecognized-line", "Repeated script start marker was ignored.", { line });
      continue;
    }

    const sceneMatch = SCENE_LINE.exec(content);
    if (sceneMatch) {
      scenes.push({ ordinal: scenes.length + 1, number: Number(sceneMatch[1]), line, blocks: [] });
      block = undefined;
      continue;
    }

    const current = scenes.at(-1);
    const fieldMatch = SCENE_FIELD.exec(content);
    if (fieldMatch) {
      block = undefined;
      const name = (fieldMatch[1] ?? "").toLowerCase() as "heading" | "start" | "end";
      if (!current) {
        report("unrecognized-line", "Scene field appears before the first scene.", { line });
      } else if (current[name]) {
        report(
          "duplicate-scene-field",
          `Scene has more than one ${name} field; the first is used.`,
          {
            line,
          },
        );
      } else {
        current[name] = { value: (fieldMatch[2] ?? "").trim(), line };
      }
      continue;
    }

    if (SCENE_BODY_MARKER.test(content)) {
      block = undefined;
      continue;
    }

    const labelMatch = LABEL.exec(content);
    if (labelMatch) {
      blockCount += 1;
      block = {
        seq: blockCount,
        line,
        endLine: line,
        label: (labelMatch[1] ?? labelMatch[2] ?? "").trim(),
        textLines: [],
        textBeforeTiming: false,
      };
      if (current) {
        current.blocks.push(block);
      } else {
        report(
          "event-before-first-scene",
          "Event appears before the first scene; it was not kept.",
          {
            line,
          },
        );
      }
      continue;
    }

    const timingMatch = TIMING.exec(content);
    if (timingMatch) {
      if (block && !block.timing) {
        block.timing = { start: unwrap(timingMatch[1]), end: unwrap(timingMatch[2]), line };
        block.textBeforeTiming = block.textLines.length > 0;
        block.endLine = line;
      } else {
        report(
          "unexpected-timing-line",
          "Timing line does not belong to an event; it was ignored.",
          {
            line,
          },
        );
      }
      continue;
    }

    if (block) {
      block.textLines.push(content);
      block.endLine = line;
      continue;
    }
    report("unrecognized-line", "Line is not part of any event; it was ignored.", { line });
  }

  const firstScene = scenes[0];
  if (!sawStart && firstScene) {
    report("missing-script-start", "Script start marker is missing.", { line: firstScene.line });
  }
  if (section === "script") report("missing-script-end", "Script end marker is missing.");
  if (afterEnd.count > 0) {
    report(
      "content-after-script-end",
      `${afterEnd.count} non-empty line(s) after the script end marker were ignored.`,
      { line: afterEnd.firstLine },
    );
  }

  return { headerFields, scenes };
}

function readHeaderLine(content: string, line: number, fields: HeaderField[], report: Report) {
  if (LABEL.test(content) || TIMING.test(content)) {
    report("unrecognized-line", "Event line appears before the script; it was ignored.", { line });
    return;
  }
  const match = HEADER_FIELD.exec(content);
  if (match) {
    fields.push({ key: (match[1] ?? "").trim(), value: (match[2] ?? "").trim(), line });
    return;
  }
  const previous = fields.at(-1);
  if (previous && headerRole(previous.key) !== "number") {
    // A wrapped free-text value, such as a long logline.
    previous.value = `${previous.value} ${content}`.trim();
    return;
  }
  report("unrecognized-line", "Line before the script is not a header field; it was ignored.", {
    line,
  });
}

function headerRole(key: string) {
  return HEADER_ROLES[key.toUpperCase().replace(/\s+/g, " ")];
}

function readHeader(fields: HeaderField[], report: Report) {
  const writerNotes: WriterNotes = { otherFields: [] };
  let numberField: Field | undefined;
  const seen = new Set<string>();

  for (const field of fields) {
    const role = headerRole(field.key);
    if (!role) {
      writerNotes.otherFields.push({ key: field.key, value: field.value });
      continue;
    }
    if (seen.has(role)) {
      report("duplicate-header-field", "Header field appears more than once; the first is used.", {
        line: field.line,
      });
      continue;
    }
    seen.add(role);
    if (role === "number") numberField = field;
    else if (field.value) writerNotes[role] = field.value;
  }
  return { numberField, writerNotes };
}

function resolveEpisodeNumber(field: Field | undefined, path: string, report: Report) {
  const fromHeader = field ? episodeNumberIn(field.value) : undefined;
  const fromName = episodeNumberFromFileName(path);

  if (fromHeader !== undefined) {
    if (fromName !== undefined && fromName !== fromHeader) {
      report(
        "episode-number-mismatch",
        `Header says episode ${fromHeader} but the file name says ${fromName}; the header is used.`,
        field ? { line: field.line } : {},
      );
    }
    return fromHeader;
  }
  if (fromName !== undefined) {
    report(
      "episode-number-from-filename",
      `Header has no valid episode number; using ${fromName} from the file name.`,
      field ? { line: field.line } : {},
    );
    return fromName;
  }
  report(
    "missing-episode-number",
    "No episode number in the header or the file name.",
    field ? { line: field.line } : {},
  );
  return undefined;
}

function episodeNumberIn(value: string): number | undefined {
  const match = /\d+/.exec(value);
  return match ? validEpisodeNumber(match[0]) : undefined;
}

export function episodeNumberFromFileName(path: string): number | undefined {
  const name = path.split("/").at(-1) ?? "";
  const match =
    /(?:^|[^a-z])(?:episode|ep|e)[\s._-]*(\d{1,4})(?!\d)/i.exec(name) ??
    /^(\d{1,4})(?!\d)/.exec(name);
  return match ? validEpisodeNumber(match[1] ?? "") : undefined;
}

function validEpisodeNumber(digits: string): number | undefined {
  const value = Number(digits);
  return Number.isInteger(value) && value >= 1 && value <= 9999 ? value : undefined;
}

function buildEpisode(
  number: number,
  sourceFile: string,
  writerNotes: WriterNotes,
  pendingScenes: PendingScene[],
  report: Report,
): Episode | null {
  const episodeId = `E${pad(number, 3)}`;
  const scenes: Scene[] = [];
  const events: ScreenplayEvent[] = [];

  for (const pending of pendingScenes) {
    const sceneId = `${episodeId}-S${pad(pending.ordinal, 2)}`;
    const sceneEvents = pending.blocks.flatMap((block) => {
      const event = buildEvent(block, episodeId, sceneId, report);
      return event ? [event] : [];
    });
    const scene = buildScene(pending, sceneId, sceneEvents, report);
    if (!scene) continue;

    if (pending.number !== pending.ordinal) {
      report(
        "scene-number-sequence",
        `Scene is numbered ${pending.number} but is scene ${pending.ordinal} in the file.`,
        { line: pending.line, ref: sceneId },
      );
    }
    checkEventsInsideScene(scene, sceneEvents, report);
    scenes.push(scene);
    events.push(...sceneEvents);
  }

  if (scenes.length === 0) return null;

  checkSceneOrder(scenes, report);
  checkSourceOrder(events, report);
  reportOverlaps(events, "dialogue", report);
  reportOverlaps(events, "camera", report);

  return {
    id: episodeId,
    number,
    sourceFile,
    durationMs: Math.max(...scenes.map((scene) => scene.endMs)),
    writerNotes,
    scenes,
    events,
  };
}

function buildEvent(
  block: PendingBlock,
  episodeId: string,
  sceneId: string,
  report: Report,
): ScreenplayEvent | undefined {
  const id = `${episodeId}-${pad(block.seq, 4)}`;
  const at = { line: block.line, ref: id };

  const label = parseLabel(block.label);
  if (!label) {
    report("invalid-label", "Event label has no name; the event was not kept.", at);
    return undefined;
  }
  if (!block.timing) {
    report("missing-timing", "Event has no Start and End line; it was not kept.", at);
    return undefined;
  }

  const { start: startText, end: endText } = block.timing;
  const startMs = parseTimecode(startText);
  const endMs = parseTimecode(endText);
  if (startMs === undefined || endMs === undefined) {
    const which = startMs === undefined ? "Start" : "End";
    report("invalid-timestamp", `${which} time is not a valid timestamp; the event was not kept.`, {
      line: block.timing.line,
      ref: id,
    });
    return undefined;
  }
  if (endMs < startMs) {
    report(
      "reversed-time-range",
      `Event ends (${endText}) before it starts (${startText}); it was not kept.`,
      at,
    );
    return undefined;
  }
  if (endMs === startMs) report("zero-length-event", `Event starts and ends at ${startText}.`, at);
  if (block.textBeforeTiming) {
    report("timing-after-text", "Event text appears before its timing line.", at);
  }

  const text = block.textLines.join("\n");
  if (!text) report("missing-event-text", "Event has no text.", at);

  const base = {
    id,
    seq: block.seq,
    sceneId,
    kind: label.kind,
    startMs,
    endMs,
    startText,
    endText,
    text,
  };

  if (label.kind !== "dialogue") {
    return { ...base, notes: label.notes, line: block.line, endLine: block.endLine };
  }
  if (text && !/^["\u201c][\s\S]*["\u201d]$/.test(text)) {
    report("dialogue-not-quoted", "Dialogue text is not in quotation marks.", at);
  }
  return {
    ...base,
    speaker: label.name,
    notes: label.notes,
    delivery: deliveryFrom(label.notes),
    line: block.line,
    endLine: block.endLine,
  };
}

function parseLabel(label: string) {
  const notes = [...label.matchAll(/\(([^()]*)\)/g)]
    .map((match) => (match[1] ?? "").trim())
    .filter(Boolean);
  const name = label
    .replace(/\([^()]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || /[()]/.test(name)) return undefined;
  const kind: EventKind = STRUCTURAL_LABELS[name.toUpperCase()] ?? "dialogue";
  return { kind, name, notes };
}

function deliveryFrom(notes: string[]): Delivery {
  const tokens = notes
    .flatMap((note) => note.split(/[/,;]/))
    .map((token) => token.toUpperCase().replace(/[.\s-]/g, ""));
  if (tokens.includes("VO")) return "voice-over";
  if (tokens.some((token) => ["OS", "OC", "OFFSCREEN"].includes(token))) return "off-screen";
  return "on-screen";
}

function buildScene(
  pending: PendingScene,
  sceneId: string,
  events: ScreenplayEvent[],
  report: Report,
): Scene | undefined {
  const at = { line: pending.line, ref: sceneId };
  const heading = pending.heading?.value ?? "";
  if (!heading) report("missing-scene-heading", "Scene has no heading.", at);

  const start = sceneTime(pending.start, "start", sceneId, report);
  const end = sceneTime(pending.end, "end", sceneId, report);
  if (start === null || end === null) return undefined;

  let startMs = start;
  let endMs = end;
  if (startMs === undefined || endMs === undefined) {
    if (events.length === 0) {
      report(
        "scene-time-missing",
        "Scene has no start or end time and no events to derive it from; it was not kept.",
        at,
      );
      return undefined;
    }
    if (startMs === undefined) {
      startMs = Math.min(...events.map((event) => event.startMs));
      report(
        "scene-time-derived",
        `Scene start time is missing; ${formatTimecode(startMs)} was taken from its first event.`,
        at,
      );
    }
    if (endMs === undefined) {
      endMs = Math.max(...events.map((event) => event.endMs));
      report(
        "scene-time-derived",
        `Scene end time is missing; ${formatTimecode(endMs)} was taken from its last event.`,
        at,
      );
    }
  }

  if (endMs < startMs) {
    report("reversed-time-range", "Scene ends before it starts; it was not kept.", at);
    return undefined;
  }
  if (events.length === 0) report("empty-scene", "Scene has no events.", at);

  return {
    id: sceneId,
    number: pending.number,
    heading,
    ...splitHeading(heading),
    startMs,
    endMs,
    startText: pending.start?.value ? unwrap(pending.start.value) : null,
    endText: pending.end?.value ? unwrap(pending.end.value) : null,
    line: pending.line,
  };
}

/** Returns ms, undefined when the field is absent, or null when it is present but invalid. */
function sceneTime(
  field: Field | undefined,
  name: "start" | "end",
  sceneId: string,
  report: Report,
): number | undefined | null {
  if (!field?.value) return undefined;
  const ms = parseTimecode(unwrap(field.value));
  if (ms !== undefined) return ms;
  report(
    "invalid-timestamp",
    `Scene ${name} time is not a valid timestamp; the scene was not kept.`,
    { line: field.line, ref: sceneId },
  );
  return null;
}

function splitHeading(heading: string): Pick<Scene, "setting" | "location" | "timeOfDay"> {
  const settingMatch = SETTING.exec(heading);
  const setting = settingMatch?.[1];
  const rest = (settingMatch ? settingMatch[2] : heading)?.trim() ?? "";
  const parts = LAST_SEPARATOR.exec(rest);
  const timeOfDay = parts && TIME_OF_DAY.test(parts[2] ?? "") ? parts[2] : undefined;
  const location = timeOfDay ? parts?.[1] : rest;
  return {
    ...(setting ? { setting } : {}),
    ...(location ? { location } : {}),
    ...(timeOfDay ? { timeOfDay } : {}),
  };
}

function checkEventsInsideScene(scene: Scene, events: ScreenplayEvent[], report: Report) {
  for (const event of events) {
    if (event.startMs < scene.startMs || event.endMs > scene.endMs) {
      report(
        "event-outside-scene",
        `Event runs ${event.startText} to ${event.endText}, outside its scene ` +
          `(${formatTimecode(scene.startMs)} to ${formatTimecode(scene.endMs)}). Times were kept as written.`,
        { line: event.line, ref: event.id },
      );
    }
  }
}

function checkSceneOrder(scenes: Scene[], report: Report) {
  scenes.forEach((scene, index) => {
    const previous = scenes[index - 1];
    if (!previous) return;
    const at = { line: scene.line, ref: scene.id };
    if (scene.startMs < previous.startMs) {
      report("scene-out-of-order", "Scene starts before the previous scene.", at);
    } else if (scene.startMs < previous.endMs) {
      report(
        "scene-overlap",
        `Scene starts ${previous.endMs - scene.startMs} ms before the previous scene ends.`,
        at,
      );
    } else if (scene.startMs > previous.endMs) {
      report(
        "scene-gap",
        `Scene starts ${scene.startMs - previous.endMs} ms after the previous scene ends.`,
        at,
      );
    }
  });
}

function checkSourceOrder(events: ScreenplayEvent[], report: Report) {
  events.forEach((event, index) => {
    const previous = events[index - 1];
    if (previous && event.startMs < previous.startMs) {
      report(
        "event-out-of-order",
        `Event starts at ${event.startText}, before the previous event in the file (${previous.startText}). Both were kept.`,
        { line: event.line, ref: event.id },
      );
    }
  });
}

function reportOverlaps(events: ScreenplayEvent[], kind: "dialogue" | "camera", report: Report) {
  const sorted = events
    .filter((event) => event.kind === kind)
    .sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
  let latest: ScreenplayEvent | undefined;
  for (const event of sorted) {
    if (latest && event.startMs < latest.endMs) {
      const overlapMs = Math.min(latest.endMs, event.endMs) - event.startMs;
      report(
        kind === "dialogue" ? "dialogue-overlap" : "camera-overlap",
        `Overlaps ${latest.id} by ${overlapMs} ms.`,
        { line: event.line, ref: event.id },
      );
    }
    if (!latest || event.endMs > latest.endMs) latest = event;
  }
}

function unwrap(token: string | undefined): string {
  return (token ?? "")
    .trim()
    .replace(/^\((.*)\)$/, "$1")
    .trim();
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
