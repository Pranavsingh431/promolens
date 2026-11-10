import { describe, expect, it } from "vitest";

import { MAX_ARCHIVE_BYTES } from "@/domain/screenplay/limits";

import { UPLOAD_LIMIT_LABEL, checkUpload } from "./upload-rules";

const file = (name: string, size: number) => {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
};

describe("checkUpload", () => {
  it("accepts one ZIP, whatever the case of its extension", () => {
    expect(checkUpload([file("show.zip", 10)]).ok).toBe(true);
    expect(checkUpload([file("SHOW.ZIP", 10)]).ok).toBe(true);
  });

  it("accepts a file exactly at the limit and refuses one byte more", () => {
    expect(checkUpload([file("a.zip", MAX_ARCHIVE_BYTES)]).ok).toBe(true);
    const over = checkUpload([file("a.zip", MAX_ARCHIVE_BYTES + 1)]);
    expect(over).toMatchObject({ ok: false });
    expect(over.ok ? "" : over.message).toContain(UPLOAD_LIMIT_LABEL);
  });

  it.each([
    ["no file", [] as File[], "No file was added"],
    ["another type", [file("notes.pdf", 10)], "not a ZIP"],
    ["an empty file", [file("a.zip", 0)], "empty"],
    ["several files", [file("a.zip", 1), file("b.zip", 1)], "one ZIP at a time"],
  ])("explains %s", (_label, files, expected) => {
    const result = checkUpload(files);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain(expected);
  });

  it("states the limit the server enforces", () => {
    expect(UPLOAD_LIMIT_LABEL).toBe("25 MB");
  });
});
