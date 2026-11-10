import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { fixtureText } from "../../../tests/support/fixtures";
import { DIAGNOSTIC_SEVERITY, type Diagnostic } from "./diagnostics";
import { episodeNumberFromFileName, parseEpisode } from "./parse-episode";
import { episodeSchema } from "./schema";

const EP1 = fixtureText("episode-01.txt");
const EP2 = fixtureText("episode-02.txt");
const EP3 = fixtureText("episode-03.txt");

function parse(text: string, path = "show/script.txt") {
  return parseEpisode({ path, text });
}

function codes(diagnostics: Diagnostic[]) {
  return diagnostics.map((d) => d.code);
}

/** A one-scene episode with the given event blocks. */
function episodeWith(blocks: string, header = "EPISODE NUMBER: Episode 4") {
  return [
    header,
    "",
    "--- SCRIPT START ---",
    "",
    "SCENE 01",
    "Scene heading: INT. HOLD - NIGHT",
    "Scene start: 00:00.00",
    "Scene end: 00:30.00",
    "",
    "Actions and dialogue:",
    "",
    blocks.trim(),
    "",
    "--- SCRIPT END ---",
    "",
  ].join("\n");
}

describe("parseEpisode on the standard format", () => {
  const { episode, diagnostics } = parse(EP1, "show/episode-01.txt");

  it("reads the header, keeping writer notes apart from on-screen content", () => {
    expect(episode?.id).toBe("E001");
    expect(episode?.number).toBe(1);
    expect(episode?.writerNotes.logline).toMatch(/^A stowaway hides/);
    expect(episode?.writerNotes.continuityNotes).toMatch(/^First episode/);
    expect(episode?.writerNotes.otherFields).toEqual([]);
    expect(JSON.stringify(episode?.events)).not.toContain("stowaway hides");
  });

  it("reads scenes with exact times and the raw heading split into parts", () => {
    expect(episode?.scenes).toEqual([
      {
        id: "E001-S01",
        number: 1,
        heading: "EXT. FERRY DECK \u2013 NIGHT",
        setting: "EXT.",
        location: "FERRY DECK",
        timeOfDay: "NIGHT",
        startMs: 0,
        endMs: 20_000,
        startText: "00:00.00",
        endText: "00:20.00",
        line: 7,
      },
      {
        id: "E001-S02",
        number: 2,
        heading: "INT. CAPTAIN'S CABIN \u2013 CONTINUOUS",
        setting: "INT.",
        location: "CAPTAIN'S CABIN",
        timeOfDay: "CONTINUOUS",
        startMs: 20_000,
        endMs: 45_000,
        startText: "00:20.00",
        endText: "00:45.00",
        line: 54,
      },
    ]);
    expect(episode?.durationMs).toBe(45_000);
  });

  it("keeps every event in source order with stable ids and line references", () => {
    const events = episode?.events ?? [];
    expect(events).toHaveLength(17);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect(events[0]).toEqual({
      id: "E001-0001",
      seq: 1,
      sceneId: "E001-S01",
      kind: "camera",
      startMs: 0,
      endMs: 4_500,
      startText: "00:00.00",
      endText: "00:04.50",
      text: "Wide shot of a ferry cutting through black water, its deck lights flickering.",
      notes: [],
      line: 14,
      endLine: 16,
    });

    const lines = EP1.split("\n");
    for (const event of events) {
      expect(lines[event.line - 1]).toMatch(/^\*\*.+:\*\*$/);
      expect(lines[event.line]).toMatch(/^Start: \(/);
      expect(lines[event.endLine - 1]?.trim()).toBe(event.text.split("\n").at(-1));
    }
  });

  it("parses speakers, parentheticals, and delivery without merging labels", () => {
    const dialogue = (episode?.events ?? []).filter((e) => e.kind === "dialogue");
    expect(dialogue.map((e) => [e.speaker, e.notes, e.delivery])).toEqual([
      ["CAPTAIN ODA", ["O.S.", "Sharp"], "off-screen"],
      ["MARA", ["V.O.", "Whispering"], "voice-over"],
      ["CAPTAIN ODA", ["Cold"], "on-screen"],
      ["MARA", ["Defiant"], "on-screen"],
      ["THE PURSER", ["Nervous"], "on-screen"],
      ["CAPTAIN ODA", [], "on-screen"],
    ]);
    expect(dialogue[0]?.text).toBe('"Who\'s back there?"');
  });

  it("reports only the known anomalies in the fixture", () => {
    expect(diagnostics.map((d) => [d.code, d.ref, d.line])).toEqual([
      ["dialogue-overlap", "E001-0008", 42],
      ["event-out-of-order", "E001-0014", 73],
      ["event-outside-scene", "E001-0017", 85],
    ]);
    expect(diagnostics.every((d) => d.file === "show/episode-01.txt" && d.episode === 1)).toBe(
      true,
    );
  });

  it("conforms to the canonical schema", () => {
    expect(episodeSchema.safeParse(episode).success).toBe(true);
  });
});

describe("format variations", () => {
  it("accepts upper-case field labels and hyphen separators", () => {
    const { episode, diagnostics } = parse(EP2, "show/episode-02.txt");
    expect(diagnostics).toEqual([]);
    expect(episode?.scenes.map((s) => [s.location, s.timeOfDay, s.startText, s.endText])).toEqual([
      ["CAPTAIN'S CABIN", "CONTINUOUS", "00:00.00", "00:30.00"],
      ["FERRY DECK", "NIGHT", "00:30.00", "00:52.25"],
    ]);
    expect(episode?.events).toHaveLength(10);
  });

  it("keeps optional header fields optional and preserves unknown ones", () => {
    const { episode } = parse(EP2, "show/episode-02.txt");
    expect(episode?.writerNotes).toEqual({
      continuityNotes: "Picks up seconds after Episode 1.",
      otherFields: [{ key: "WRITER DRAFT", value: "3" }],
    });
  });

  it.each([
    ["INT. HOLD \u2013 NIGHT", { setting: "INT.", location: "HOLD", timeOfDay: "NIGHT" }],
    ["INT. HOLD \u2014 NIGHT", { setting: "INT.", location: "HOLD", timeOfDay: "NIGHT" }],
    ["int. hold - dusk", { setting: "int.", location: "hold", timeOfDay: "dusk" }],
    [
      "INT. MANOR - WEST WING - NIGHT",
      { setting: "INT.", location: "MANOR - WEST WING", timeOfDay: "NIGHT" },
    ],
    ["EXT. CASTLE - DUNGEON", { setting: "EXT.", location: "CASTLE - DUNGEON" }],
    ["INT./EXT. CAR - DAY", { setting: "INT./EXT.", location: "CAR", timeOfDay: "DAY" }],
    ["ENGINE ROOM", { location: "ENGINE ROOM" }],
  ])("splits the heading %j without normalizing it", (heading, parts) => {
    const text = episodeWith("**CAMERA:**\nStart: (00:00.00) | End: (00:30.00)\nA shot.").replace(
      "INT. HOLD - NIGHT",
      heading,
    );
    const scene = parse(text).episode?.scenes[0];
    expect(scene?.heading).toBe(heading);
    expect({
      setting: scene?.setting,
      location: scene?.location,
      timeOfDay: scene?.timeOfDay,
    }).toEqual({
      setting: undefined,
      timeOfDay: undefined,
      ...parts,
    });
  });

  it("keeps millisecond precision exactly as written", () => {
    const camera = parse(EP3, "show/episode-03.txt").episode?.events[0];
    expect(camera).toMatchObject({ endMs: 10_125, endText: "00:10.125" });
  });

  it("produces the same result for LF, CRLF, and CR line endings", () => {
    const lf = parse(EP1, "show/episode-01.txt");
    expect(parse(EP1.replaceAll("\n", "\r\n"), "show/episode-01.txt")).toEqual(lf);
    expect(parse(EP1.replaceAll("\n", "\r"), "show/episode-01.txt")).toEqual(lf);
  });

  it("keeps multi-line event text and blank lines inside an event", () => {
    const text = episodeWith(
      "**ACTION:**\nStart: (00:01.00) | End: (00:02.00)\nShe runs.\n\nThe door slams.",
    );
    const [event] = parse(text).episode?.events ?? [];
    expect(event?.text).toBe("She runs.\nThe door slams.");
    expect(event?.endLine).toBe((event?.line ?? 0) + 4);
  });
});

describe("anomalies are kept and reported", () => {
  it("keeps overlapping dialogue and only notes it", () => {
    const text = episodeWith(`
**ANA:**
Start: (00:01.00) | End: (00:03.00)
"Wait."

**BEN:**
Start: (00:02.50) | End: (00:04.00)
"No."
`);
    const { episode, diagnostics } = parse(text);
    expect(episode?.events).toHaveLength(2);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "dialogue-overlap", severity: "info", ref: "E004-0002" }),
    ]);
  });

  it("keeps out-of-order events in source order", () => {
    const text = episodeWith(`
**CAMERA:**
Start: (00:05.00) | End: (00:09.00)
Second shot.

**CAMERA:**
Start: (00:00.00) | End: (00:05.00)
First shot.
`);
    const { episode, diagnostics } = parse(text);
    expect(episode?.events.map((e) => e.startMs)).toEqual([5_000, 0]);
    expect(codes(diagnostics)).toEqual(["event-out-of-order"]);
  });

  it("keeps the raw times of an event that runs past its scene", () => {
    const text = episodeWith("**SOUND FX:**\nStart: (00:29.00) | End: (00:31.50)\nA bell.");
    const { episode, diagnostics } = parse(text);
    expect(episode?.events[0]).toMatchObject({ startMs: 29_000, endMs: 31_500 });
    expect(codes(diagnostics)).toEqual(["event-outside-scene"]);
  });

  it("keeps zero-length events and warns", () => {
    const text = episodeWith("**SOUND FX:**\nStart: (00:04.00) | End: (00:04.00)\nA click.");
    expect(codes(parse(text).diagnostics)).toEqual(["zero-length-event"]);
  });

  it("notes unquoted dialogue, which may be a mislabelled direction", () => {
    const text = episodeWith(
      "**TEXT ON SCREEN:**\nStart: (00:01.00) | End: (00:02.00)\nTen years later",
    );
    const { episode, diagnostics } = parse(text);
    expect(episode?.events[0]).toMatchObject({ kind: "dialogue", speaker: "TEXT ON SCREEN" });
    expect(codes(diagnostics)).toEqual(["dialogue-not-quoted"]);
  });
});

describe("missing or broken input", () => {
  it("rejects an empty file", () => {
    expect(parse("  \n\n").episode).toBeNull();
    expect(codes(parse("").diagnostics)).toEqual(["empty-file"]);
  });

  it("drops an event without timing, reports an error, and keeps the other ids stable", () => {
    const text = episodeWith(`
**CAMERA:**
A shot with no timing.

**CAMERA:**
Start: (00:01.00) | End: (00:02.00)
A good shot.
`);
    const { episode, diagnostics } = parse(text);
    expect(episode?.events.map((e) => e.id)).toEqual(["E004-0002"]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "missing-timing", severity: "error", ref: "E004-0001" }),
    ]);
  });

  it.each(["00:61.00", "0:1:2", "00:05.5555", "soon", ""])(
    "rejects the invalid timestamp %j",
    (bad) => {
      const text = episodeWith(`**CAMERA:**\nStart: (${bad}) | End: (00:02.00)\nA shot.`);
      const { episode, diagnostics } = parse(text);
      expect(episode?.events).toEqual([]);
      expect(codes(diagnostics)).toContain("invalid-timestamp");
    },
  );

  it("rejects a reversed time range instead of swapping it", () => {
    const text = episodeWith("**CAMERA:**\nStart: (00:05.00) | End: (00:02.00)\nA shot.");
    const { episode, diagnostics } = parse(text);
    expect(episode?.events).toEqual([]);
    expect(codes(diagnostics)).toEqual(["empty-scene", "reversed-time-range"]);
  });

  it("uses the file name when the header has no episode number", () => {
    const text = episodeWith(
      "**CAMERA:**\nStart: (00:00.00) | End: (00:01.00)\nA shot.",
      "EPISODE LOGLINE: x",
    );
    const { episode, diagnostics } = parse(text, "show/episode-007-final.txt");
    expect(episode?.number).toBe(7);
    expect(codes(diagnostics)).toEqual(["episode-number-from-filename"]);
  });

  it("fails when no episode number can be found", () => {
    const text = episodeWith(
      "**CAMERA:**\nStart: (00:00.00) | End: (00:01.00)\nA shot.",
      "EPISODE LOGLINE: x",
    );
    const { episode, diagnostics } = parse(text, "show/pilot.txt");
    expect(episode).toBeNull();
    expect(codes(diagnostics)).toEqual(["missing-episode-number"]);
  });

  it("warns when the header and file name disagree, and trusts the header", () => {
    const { episode, diagnostics } = parse(EP2, "show/episode-09.txt");
    expect(episode?.number).toBe(2);
    expect(codes(diagnostics)).toEqual(["episode-number-mismatch"]);
  });

  it("fails when there are no scenes", () => {
    const { episode, diagnostics } = parse(
      "EPISODE NUMBER: 3\n--- SCRIPT START ---\n--- SCRIPT END ---\n",
    );
    expect(episode).toBeNull();
    expect(codes(diagnostics)).toEqual(["no-scenes"]);
  });

  it("derives a missing scene time from its events and says so", () => {
    const text = episodeWith("**CAMERA:**\nStart: (00:00.00) | End: (00:12.00)\nA shot.").replace(
      "Scene end: 00:30.00\n",
      "",
    );
    const { episode, diagnostics } = parse(text);
    expect(episode?.scenes[0]).toMatchObject({ endMs: 12_000, endText: null });
    expect(codes(diagnostics)).toEqual(["scene-time-derived"]);
  });

  it("reports structural problems with line numbers", () => {
    const text = [
      "EPISODE NUMBER: Episode 5",
      "**CAMERA:**",
      "Start: (00:00.00) | End: (00:01.00)",
      "SCENE 01",
      "Start: (00:00.00) | End: (00:01.00)",
      "stray line",
      "**CAMERA:**",
      "Start: (00:00.00) | End: (00:01.00)",
      "A shot.",
      "--- SCRIPT END ---",
      "trailing note",
    ].join("\n");
    const { diagnostics } = parse(text, "show/episode-05.txt");
    expect(diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["unrecognized-line", 2],
      ["unrecognized-line", 3],
      ["missing-scene-heading", 4],
      ["missing-script-start", 4],
      ["scene-time-derived", 4],
      ["scene-time-derived", 4],
      ["unexpected-timing-line", 5],
      ["unrecognized-line", 6],
      ["content-after-script-end", 11],
    ]);
  });
});

describe("determinism and robustness", () => {
  it("returns identical output for identical input", () => {
    expect(JSON.stringify(parse(EP1))).toBe(JSON.stringify(parse(EP1)));
  });

  it("never throws, and every result it returns satisfies the schema", () => {
    const fragments = [
      "SCENE 01",
      "SCENE 2",
      "Scene heading: INT. ROOM - DAY",
      "SCENE START: 00:00.00",
      "Scene end: 00:20.00",
      "Scene end: 00:05.00",
      "**CAMERA:**",
      "**MARA (O.S.):**",
      "**(V.O.):**",
      "Start: (00:01.00) | End: (00:02.50)",
      "Start: (00:03.00) | End: (00:01.00)",
      "Start: (99:99.99) | End: (00:01.00)",
      '"A line."',
      "--- SCRIPT START ---",
      "--- SCRIPT END ---",
      "EPISODE NUMBER: Episode 1",
      "",
    ];
    const line = fc.oneof(fc.constantFrom(...fragments), fc.string({ maxLength: 30 }));

    fc.assert(
      fc.property(fc.array(line, { maxLength: 60 }), (lines) => {
        const { episode, diagnostics } = parse(lines.join("\n"), "show/episode-01.txt");
        for (const item of diagnostics) {
          expect(item.severity).toBe(DIAGNOSTIC_SEVERITY[item.code]);
        }
        if (episode) expect(episodeSchema.safeParse(episode).success).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe("episodeNumberFromFileName", () => {
  it.each([
    ["show/episode-001-Episode 9000001.txt", 1],
    ["EP12.txt", 12],
    ["s01e05.txt", 5],
    ["Episode_42_final.md", 42],
    ["003.txt", 3],
    ["pilot.txt", undefined],
    ["episode-0.txt", undefined],
  ])("reads %s as %s", (path, expected) => {
    expect(episodeNumberFromFileName(path)).toBe(expected);
  });
});
