import { describe, expect, it } from "vitest";

import { formatTimecode } from "@/domain/screenplay/timecode";

import { formatFileSize, formatRange, formatSeconds } from "./format";

describe("display formatting", () => {
  it("prints timecodes from integer milliseconds without rounding up", () => {
    expect(formatTimecode(125_040)).toBe("02:05.04");
    expect(formatTimecode(59_999)).toBe("00:59.99");
    expect(formatRange(5_000, 31_000)).toBe("00:05.00 to 00:31.00");
  });

  it("prints durations in seconds", () => {
    expect(formatSeconds(34_880)).toBe("34.9 s");
    expect(formatSeconds(20_000)).toBe("20.0 s");
  });

  it("prints file sizes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2_048)).toBe("2.0 KB");
    expect(formatFileSize(25 * 1024 * 1024)).toBe("25 MB");
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});
