import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { formatTimecode, parseTimecode } from "./timecode";

describe("parseTimecode", () => {
  it.each([
    ["00:00.00", 0],
    ["00:00.07", 70],
    ["00:04.80", 4_800],
    ["01:23.45", 83_450],
    ["02:18.00", 138_000],
    ["0:05.5", 5_500],
    ["00:10.125", 10_125],
    ["03:20", 200_000],
    ["75:00.00", 4_500_000],
    ["1:02:03.04", 3_723_040],
  ])("converts %s to exactly %i ms", (text, ms) => {
    expect(parseTimecode(text)).toBe(ms);
  });

  it.each([
    ["", "empty"],
    ["00:60.00", "seconds out of range"],
    ["1:60:00", "minutes out of range with hours"],
    ["1:5:00", "one-digit minutes with hours"],
    ["00:05.1234", "more precision than a millisecond"],
    ["-00:01.00", "negative"],
    ["00:1.00", "one-digit seconds"],
    ["00:01.", "dangling decimal point"],
    ["00:01,50", "comma decimal"],
    [" 00:01.00", "surrounding space"],
    ["abc", "text"],
  ])("rejects %j (%s)", (text) => {
    expect(parseTimecode(text)).toBeUndefined();
  });

  it("round-trips every millisecond value through the exact format", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999 * 60_000 + 59_999 }), (ms) => {
        expect(parseTimecode(formatTimecode(ms, 3))).toBe(ms);
      }),
    );
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const ms = parseTimecode(text);
        expect(ms === undefined || (Number.isSafeInteger(ms) && ms >= 0)).toBe(true);
      }),
    );
  });
});

describe("formatTimecode", () => {
  it("pads minutes and seconds and truncates extra precision", () => {
    expect(formatTimecode(4_800)).toBe("00:04.80");
    expect(formatTimecode(10_125)).toBe("00:10.12");
    expect(formatTimecode(10_125, 3)).toBe("00:10.125");
    expect(formatTimecode(4_500_000, 0)).toBe("75:00");
  });

  it("rejects values that are not whole non-negative milliseconds", () => {
    expect(() => formatTimecode(-1)).toThrow(RangeError);
    expect(() => formatTimecode(1.5)).toThrow(RangeError);
  });
});
