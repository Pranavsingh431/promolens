import { describe, expect, it } from "vitest";

import { readZipArchive } from "../../src/server/ingest/zip";
import { buildZip } from "../support/zip-builder";

const SCRIPT = "EPISODE NUMBER: Episode 1\n--- SCRIPT START ---\n";

async function failure(archive: Uint8Array, limits = {}) {
  const result = await readZipArchive(archive, limits);
  if (result.ok) throw new Error("Expected the archive to be rejected");
  return result.diagnostic;
}

describe("readZipArchive rejects malformed archives", () => {
  it("rejects an empty upload", async () => {
    expect(await failure(new Uint8Array())).toMatchObject({ code: "invalid-archive" });
  });

  it("rejects bytes that are not a ZIP", async () => {
    const noise = new Uint8Array(512).map((_, i) => (i * 7919) % 251);
    expect(await failure(noise)).toMatchObject({ code: "invalid-archive" });
  });

  it("rejects a truncated archive", async () => {
    const zip = buildZip([{ name: "a.txt", data: SCRIPT }]);
    expect(await failure(zip.subarray(0, zip.length - 10))).toMatchObject({
      code: "invalid-archive",
    });
  });

  it("rejects a file whose checksum does not match", async () => {
    const zip = buildZip([{ name: "a.txt", data: SCRIPT, crc: 1234 }]);
    expect(await failure(zip)).toMatchObject({ code: "corrupt-entry", file: "a.txt" });
  });

  it("rejects the same path listed twice", async () => {
    const zip = buildZip([
      { name: "show/a.txt", data: SCRIPT },
      { name: "show/a.txt", data: SCRIPT },
    ]);
    expect(await failure(zip)).toMatchObject({ code: "duplicate-entry" });
  });
});

describe("readZipArchive rejects unsafe entries", () => {
  it.each([
    "../escape.txt",
    "show/../../escape.txt",
    "..\\escape.txt",
    "/etc/passwd",
    "C:/Windows/evil.txt",
    "show/bad\u0001name.txt",
  ])("rejects the path %j", async (name) => {
    const zip = buildZip([{ name, data: SCRIPT }]);
    expect(await failure(zip)).toMatchObject({ code: "unsafe-entry-path", severity: "error" });
  });

  it("rejects symbolic links", async () => {
    const zip = buildZip([{ name: "show/link.txt", data: "/etc/passwd", symlink: true }]);
    expect(await failure(zip)).toMatchObject({ code: "unsafe-entry" });
  });

  it("rejects encrypted files and unknown compression", async () => {
    const encrypted = buildZip([
      { name: "a.txt", data: SCRIPT, method: "deflate", encrypted: true },
    ]);
    expect(await failure(encrypted)).toMatchObject({
      code: "unsupported-entry",
    });
    expect(await failure(buildZip([{ name: "a.txt", data: SCRIPT, method: 12 }]))).toMatchObject({
      code: "unsupported-entry",
    });
  });
});

describe("readZipArchive enforces limits", () => {
  const MB = 1024 * 1024;

  it("limits the archive size", async () => {
    const zip = buildZip([{ name: "a.txt", data: "x".repeat(2_000) }]);
    expect(await failure(zip, { maxArchiveBytes: 1_000 })).toMatchObject({
      code: "archive-too-large",
    });
  });

  it("limits the number of entries", async () => {
    const zip = buildZip(["a.txt", "b.txt", "c.txt"].map((name) => ({ name, data: SCRIPT })));
    expect(await failure(zip, { maxEntries: 2 })).toMatchObject({ code: "too-many-entries" });
  });

  it("stops a ZIP bomb by its declared size before decompressing", async () => {
    const bomb = buildZip([{ name: "bomb.txt", data: new Uint8Array(20 * MB), method: "deflate" }]);
    expect(bomb.length).toBeLessThan(100_000);
    expect(await failure(bomb, { maxEntryBytes: MB })).toMatchObject({
      code: "entry-too-large",
      file: "bomb.txt",
    });
  });

  it("stops a ZIP bomb that lies about its size", async () => {
    const liar = buildZip([
      { name: "liar.txt", data: new Uint8Array(20 * MB), method: "deflate", declaredSize: 100 },
    ]);
    expect(await failure(liar, { maxEntryBytes: MB })).toMatchObject({
      code: "corrupt-entry",
      file: "liar.txt",
    });
  });

  it("limits the total uncompressed size", async () => {
    const zip = buildZip([
      { name: "a.txt", data: "x".repeat(600_000), method: "deflate" },
      { name: "b.txt", data: "x".repeat(600_000), method: "deflate" },
    ]);
    expect(await failure(zip, { maxEntryBytes: MB, maxTotalBytes: MB })).toMatchObject({
      code: "uncompressed-too-large",
      file: "b.txt",
    });
  });

  it("does not read large files it skips", async () => {
    const zip = buildZip([
      { name: "show/episode-01.txt", data: SCRIPT },
      { name: "show/trailer.mp4", data: new Uint8Array(3 * MB), method: "deflate" },
    ]);
    const result = await readZipArchive(zip, { maxEntryBytes: MB });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((file) => file.path)).toEqual(["show/episode-01.txt"]);
      expect(result.skipped.map((d) => d.file)).toEqual(["show/trailer.mp4"]);
    }
  });
});
