import { describe, expect, it } from "vitest";

import { buildZip } from "../../tests/support/zip-builder";
import { summarizeZip } from "./zip-summary";

const blob = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

describe("reading a ZIP's directory for estimates", () => {
  it("counts screenplay files and their uncompressed size, in folders too", async () => {
    const zip = buildZip([
      { name: "A Show. Part Two/" },
      { name: "A Show. Part Two/episode-001.txt", data: "x".repeat(2048) },
      { name: "A Show. Part Two/episode-002.TXT", data: "y".repeat(1024) },
      { name: "A Show. Part Two/notes.md", data: "not a screenplay" },
      { name: "__MACOSX/A Show. Part Two/._episode-001.txt", data: "junk" },
    ]);
    expect(await summarizeZip(blob(zip))).toEqual({ episodes: 2, textKb: 3 });
  });

  it("says nothing about a file that is not a ZIP, or one with no screenplays", async () => {
    expect(await summarizeZip(blob(new TextEncoder().encode("not a zip at all")))).toBeNull();
    expect(await summarizeZip(blob(buildZip([{ name: "promos.csv", data: "a,b" }])))).toBeNull();
  });
});
