import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { summarizeShow } from "../../src/domain/screenplay/summary";
import { createTimeline } from "../../src/domain/screenplay/timeline";
import { ingestScreenplayFiles, ingestScreenplayZip } from "../../src/server/ingest/ingest";
import { NIGHT_FERRY } from "../support/fixtures";
import { buildZip, type ZipEntrySpec } from "../support/zip-builder";

const episodes = (folder = "night-ferry/", transform = (text: string) => text): ZipEntrySpec[] =>
  NIGHT_FERRY.map(({ name, text }) => ({
    name: `${folder}${name}`,
    data: transform(text),
    method: "deflate",
  }));

describe("ingestScreenplayZip on a valid pack", () => {
  const archive = buildZip([
    { name: "night-ferry/" },
    ...episodes(),
    { name: "night-ferry/README.txt", data: "Three synthetic episodes for tests." },
    { name: "night-ferry/cover.jpg", data: new Uint8Array([0xff, 0xd8, 0xff]) },
    { name: "night-ferry/.DS_Store", data: "x" },
    { name: "__MACOSX/night-ferry/._episode-01.txt", data: "x" },
  ]);

  it("parses every episode and reports skipped files", async () => {
    const result = await ingestScreenplayZip(archive);
    expect(result.ok).toBe(true);
    expect(result.show?.title).toBe("night-ferry");
    expect(result.show && summarizeShow(result.show)).toEqual({
      episodes: 3,
      firstEpisode: 1,
      lastEpisode: 3,
      scenes: 5,
      events: 31,
      eventsByKind: { camera: 14, action: 4, sound: 3, dialogue: 10 },
      totalDurationMs: 45_000 + 52_250 + 24_500,
      shortestEpisodeMs: 24_500,
      longestEpisodeMs: 52_250,
      speakerLabels: 4,
    });
    expect(result.diagnostics.filter((d) => d.code === "skipped-file").map((d) => d.file)).toEqual([
      "__MACOSX/night-ferry/._episode-01.txt",
      "night-ferry/.DS_Store",
      "night-ferry/README.txt",
      "night-ferry/cover.jpg",
    ]);
    expect(result.diagnostics.filter((d) => d.severity !== "info").map((d) => d.code)).toEqual([
      "event-out-of-order",
      "event-outside-scene",
    ]);
  });

  it("records the exact source bytes of each episode", async () => {
    const result = await ingestScreenplayZip(archive);
    const first = NIGHT_FERRY[0];
    expect(result.sources[0]).toEqual({
      path: "night-ferry/episode-01.txt",
      bytes: Buffer.byteLength(first?.text ?? ""),
      sha256: createHash("sha256")
        .update(first?.text ?? "")
        .digest("hex"),
    });
  });

  it("gives the same result whatever the entry order", async () => {
    const forward = await ingestScreenplayZip(buildZip(episodes()));
    const reversed = await ingestScreenplayZip(buildZip(episodes().reverse()));
    expect(reversed).toEqual(forward);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it("parses BOM and CRLF files to the same show", async () => {
    const plain = await ingestScreenplayZip(buildZip(episodes()));
    const windows = await ingestScreenplayZip(
      buildZip(episodes("night-ferry/", (text) => `\ufeff${text.replaceAll("\n", "\r\n")}`)),
    );
    expect(windows.ok).toBe(true);
    expect(windows.show).toEqual(plain.show);
  });

  it("supports files at the archive root and names the show after the archive", async () => {
    const result = await ingestScreenplayZip(buildZip(episodes("")), { archiveName: "ferry.zip" });
    expect(result.ok).toBe(true);
    expect(result.show?.title).toBe("ferry");
    expect(result.show?.episodes.map((e) => e.sourceFile)).toEqual([
      "episode-01.txt",
      "episode-02.txt",
      "episode-03.txt",
    ]);
  });

  it("produces data the timeline can query across episodes", async () => {
    const result = await ingestScreenplayZip(archive);
    if (!result.ok) throw new Error("Expected a valid pack");
    const timeline = createTimeline(result.show);
    const parts = timeline.eventsForSegments([
      { episode: 1, startMs: 9_000, endMs: 14_000 },
      { episode: 2, startMs: 34_000, endMs: 36_250 },
    ]);
    expect(parts.map((part) => part.events.map((event) => event.id))).toEqual([
      ["E001-0005", "E001-0006", "E001-0007", "E001-0008", "E001-0009"],
      // The camera shot E002-0007 (00:30 to 00:40) spans the whole second segment.
      ["E002-0007", "E002-0009"],
    ]);
  });
});

describe("ingestion failures", () => {
  const text = (name: string) => NIGHT_FERRY.find((f) => f.name === name)?.text ?? "";
  const utf8 = (value: string) => new TextEncoder().encode(value);

  it("rejects two files that claim the same episode", async () => {
    const result = await ingestScreenplayZip(
      buildZip([
        ...episodes(),
        { name: "night-ferry/extra/episode-02-copy.txt", data: text("episode-02.txt") },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual([
      "duplicate-episode",
    ]);
  });

  it("rejects an empty screenplay file", () => {
    const result = ingestScreenplayFiles([{ path: "show/episode-04.txt", bytes: utf8("\n \n") }]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["no-screenplays", "empty-file"]);
  });

  it("rejects a file that is not UTF-8", () => {
    const result = ingestScreenplayFiles([
      { path: "show/episode-01.txt", bytes: utf8(text("episode-01.txt")) },
      { path: "show/episode-02.txt", bytes: new Uint8Array([0x45, 0xff, 0x0a]) },
    ]);
    expect(result.ok).toBe(false);
    expect(result.show?.episodes).toHaveLength(1);
    expect(result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual([
      "invalid-encoding",
    ]);
  });

  it("rejects an archive with no screenplays", async () => {
    const result = await ingestScreenplayZip(buildZip([{ name: "notes.txt", data: "Hello." }]));
    expect(result).toMatchObject({ ok: false, show: null });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["no-screenplays", "skipped-file"]);
  });

  it("fails the whole pack when one episode has an error", async () => {
    const broken = text("episode-03.txt").replace(
      "Start: (00:07.00) | End: (00:09.00)",
      "Start: (00:07.00) | End: (later)",
    );
    const result = await ingestScreenplayZip(
      buildZip([...episodes().slice(0, 2), { name: "night-ferry/episode-03.txt", data: broken }]),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.find((d) => d.severity === "error")).toMatchObject({
      code: "invalid-timestamp",
      file: "night-ferry/episode-03.txt",
      episode: 3,
      ref: "E003-0003",
    });
  });
});
