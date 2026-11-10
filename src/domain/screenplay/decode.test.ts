import { describe, expect, it } from "vitest";

import { decodeScreenplayBytes, looksLikeScreenplay } from "./decode";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("decodeScreenplayBytes", () => {
  it("removes a UTF-8 byte order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("SCENE 01")]);
    expect(decodeScreenplayBytes(bytes)).toEqual({ ok: true, text: "SCENE 01" });
  });

  it("keeps line endings for the parser to handle", () => {
    expect(decodeScreenplayBytes(utf8("a\r\nb\rc\n"))).toEqual({ ok: true, text: "a\r\nb\rc\n" });
  });

  it("rejects UTF-16 files with a clear message", () => {
    const result = decodeScreenplayBytes(new Uint8Array([0xff, 0xfe, 0x53, 0x00]));
    expect(result).toMatchObject({ ok: false, code: "unsupported-encoding" });
  });

  it("rejects bytes that are not valid UTF-8", () => {
    const result = decodeScreenplayBytes(new Uint8Array([0x53, 0xc3, 0x28]));
    expect(result).toMatchObject({ ok: false, code: "invalid-encoding" });
  });

  it("rejects binary content", () => {
    expect(decodeScreenplayBytes(utf8("SCENE\u0000"))).toMatchObject({
      ok: false,
      code: "binary-content",
    });
  });
});

describe("looksLikeScreenplay", () => {
  it("accepts text with a script start marker", () => {
    expect(looksLikeScreenplay("EPISODE NUMBER: 1\n--- SCRIPT START ---\n")).toBe(true);
  });

  it("accepts scenes with timed blocks even without markers", () => {
    expect(looksLikeScreenplay("SCENE 1\n**CAMERA:**\nStart: (00:00.00) | End: (00:01.00)\n")).toBe(
      true,
    );
  });

  it("rejects ordinary text files", () => {
    expect(looksLikeScreenplay("Read me first.\nThis pack has 50 episodes.\n")).toBe(false);
    expect(looksLikeScreenplay("SCENE 1 is great.\n")).toBe(false);
  });
});
