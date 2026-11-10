# Screenplay ingestion and parsing

This stage turns a ZIP of episode scripts into one canonical, validated show.
It is fully deterministic: no model calls, no network, and the same bytes
always give the same result.

```
ZIP bytes
  -> readZipArchive   (src/server/ingest/zip.ts)
  -> decode as UTF-8  (src/domain/screenplay/decode.ts)
  -> parseEpisode     (one file at a time)
  -> assembleShow     (duplicate episodes, gaps, ids)
  -> schema check     (Zod)
```

Entry points:

- `ingestScreenplayZip(bytes)` in `src/server/ingest/ingest.ts` for uploads.
- `ingestScreenplayFiles(files)` for files that are already extracted.
- `createTimeline(show)` in `src/domain/screenplay/timeline.ts` for time queries.

## Supported input

A ZIP with one plain-text file per episode, either at the root or inside one
or more folders. A file is treated as a screenplay when it has a `.txt`,
`.text`, or `.md` extension (or none) and its content has a script start
marker, or scene lines together with timing lines. Other files are skipped and
listed as `skipped-file`.

Each episode file looks like this:

```
EPISODE NUMBER: Episode 3
EPISODE LOGLINE: One-sentence summary.
CONTINUITY NOTES: Notes for the writers.

--- SCRIPT START ---

SCENE 01
Scene heading: INT. FERRY DECK - NIGHT
Scene start: 00:00.00
Scene end: 01:12.40

Actions and dialogue:

**CAMERA:**
Start: (00:00.00) | End: (00:03.20)
Wide shot of the deck.

**MARA (O.S.) (Whispering):**
Start: (00:02.10) | End: (00:03.90)
"Don't move."

--- SCRIPT END ---
```

Accepted variations:

- Field labels in any letter case (`Scene start:` or `SCENE START:`).
- Hyphen, en dash, or em dash between location and time of day.
- Times with or without parentheses.
- LF, CRLF, or CR line endings, with or without a UTF-8 byte order mark.
- Event text over several lines, including blank lines inside an event.
- A missing script start or end marker (reported as a warning).

Labels `CAMERA`, `ACTION`, and `SOUND FX` (plus a few synonyms such as `SFX`
and `MUSIC`) are structural. Any other label is dialogue, and the label is kept
as the speaker.

## Canonical model

Defined with Zod in `src/domain/screenplay/schema.ts`.

| Object  | Key fields                                                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Show    | `title`, `episodes` sorted by number                                                                                                                |
| Episode | `id` (`E007`), `number`, `sourceFile`, `durationMs`, `writerNotes`, `scenes`, `events`                                                              |
| Scene   | `id` (`E007-S02`), `number` as written, raw `heading` plus `setting`, `location`, `timeOfDay`, `startMs`, `endMs`, `startText`, `endText`, `line`   |
| Event   | `id` (`E007-0042`), `seq`, `sceneId`, `kind`, `startMs`, `endMs`, `startText`, `endText`, `text`, `speaker`, `notes`, `delivery`, `line`, `endLine` |

- **Ids** combine the episode number with the position in the file, so the
  same input always gives the same ids. Scene ids use the scene's position, not
  its written number, so repeated scene numbers cannot collide. An event that
  fails to parse still uses up its position, so the ids of the events after it
  do not shift once it is fixed.
- **Source order and time order are separate.** `episode.events` is in file
  order (`seq`). The timeline index sorts by start time, with `seq` breaking
  ties. Nothing is reordered in the stored data.
- **Speakers are raw labels.** `LADY X` and `X` stay different speakers. No
  aliases are merged and no place names are normalized; that needs evidence the
  parser does not have.
- **`delivery`** is derived from the parentheticals: `voice-over` for V.O.,
  `off-screen` for O.S. or O.C., otherwise `on-screen`. The raw parentheticals
  stay in `notes`.
- **Writer notes** (logline, continuity notes, any other header field) live in
  `episode.writerNotes`, apart from scenes and events. They are not on screen
  and often contain spoilers. The timeline's `eventsForSegments` returns events
  only, so a cold-viewer check built on it never sees them.

## Timestamps

- Stored as integer milliseconds from the start of the episode. Conversion uses
  integer arithmetic only: `01:23.45` is exactly `83450`.
- Accepted forms: `M:SS`, `MM:SS.f`, `MM:SS.ff`, `MM:SS.fff`, and
  `H:MM:SS(.fff)`. Seconds must be below 60. More than three fraction digits is
  rejected because it cannot be stored exactly.
- The original token is kept in `startText` and `endText`, so source precision
  is never lost.
- Intervals are half-open, `[startMs, endMs)`. A zero-length event at time t
  belongs to any range that contains t.
- Durations are plain integer subtraction.

## Validation

Every diagnostic has a severity, a code, a message, the file, and where
possible the episode, line, and scene or event id. Messages never contain
script text. The full list of codes is in
`src/domain/screenplay/diagnostics.ts`.

| Severity | Meaning                                                         | Effect                              |
| -------- | --------------------------------------------------------------- | ----------------------------------- |
| error    | Part of the input could not be represented faithfully.          | `ok` is false. Do not analyze.      |
| warning  | Unusual input that was kept as written, or a documented repair. | Analysis may run. Show the warning. |
| info     | Normal variation worth knowing, such as overlapping dialogue.   | None.                               |

Errors include: an unreadable or unsafe archive, a file that is not UTF-8, an
empty file, no episode number, no scenes, an event with missing or invalid
timing, a reversed time range, two files claiming one episode, and anything
that fails the canonical schema. The pack fails as a whole on any error, but the
diagnostics cover every file, so one run shows every problem.

Warnings include: events out of chronological order, an event that runs past
its scene, a scene time that was missing and taken from its events
(`startText` or `endText` is then `null`), gaps in episode numbers, a header
number that disagrees with the file name, and lines that were not understood.

The parser never swaps, clamps, or rounds a time to make a check pass.
Overlapping events are normal (camera directions overlap dialogue all the
time); only dialogue over dialogue and camera over camera are noted, as info.

## ZIP safety

The archive is read in memory. Nothing is written to disk.

| Limit                        | Default |
| ---------------------------- | ------- |
| Archive size                 | 25 MB   |
| Entries in the archive       | 1,000   |
| One text file, uncompressed  | 2 MB    |
| All text files, uncompressed | 50 MB   |

Limits are checked against the declared sizes before decompressing and against
the real byte count while decompressing, so a ZIP bomb stops at the limit even
when it lies about its size. Absolute paths, `..` segments, control characters,
symbolic links, duplicate paths, encrypted entries, and unknown compression
methods reject the archive. Every file is checked against its CRC-32. Results do
not depend on entry order.

## Timeline queries

`createTimeline(show)` builds a per-episode index once. Range queries use a
binary search over start times plus the longest event length, so they never
scan the whole show.

- `eventsInRange(episode, startMs, endMs, { mode, kinds })`: overlapping or
  fully contained events, optionally by kind.
- `eventsAt(episode, ms)` and `sceneAt(episode, ms)`.
- `boundariesNear(episode, ms, windowMs, { kinds })`: event starts and ends
  near a proposed cut.
- `boundaryContext(episode, ms)`: events a cut would split, plus the nearest
  events before and after.
- `checkSegment(segment)`: valid episode and bounds, plus the events each edge
  would cut.
- `eventsForSegments(segments)`: on-screen events for a multi-segment promo, in
  playback order.

## Checking a pack locally

```bash
npm run screenplays:validate -- path/to/pack.zip
```

It prints counts, screen time, and diagnostics grouped by code, and never
prints script text. Add `--all` to list every diagnostic. Exit codes: `0` valid,
`1` invalid input, `2` bad usage or unreadable file. It runs the TypeScript
source directly with Node's type stripping, so it needs no build step.

## Known limitations

- Only this timestamped plain-text format. Fountain, Final Draft, PDF, and Word
  files are not supported.
- An unknown structural label, such as `TEXT ON SCREEN`, is read as dialogue.
  It is flagged when its text is not in quotation marks.
- The time of day in a heading is recognized from a fixed word list (DAY,
  NIGHT, CONTINUOUS, and similar). Anything else stays part of the location.
- The episode number is the first number in the header field. Spelled-out
  numbers fall back to the file name.
- One show per archive. Two seasons with repeated episode numbers are rejected
  as duplicates.
- A wrapped header line that itself looks like `Key: value` is read as a new
  header field.
