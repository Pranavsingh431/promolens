import { describe, expect, it } from "vitest";

import { fixtureText } from "../../../tests/support/fixtures";
import { assembleShow, formatRanges } from "./assemble-show";
import { parseEpisode } from "./parse-episode";
import { showSchema } from "./schema";

const ep = (path: string, name = path.split("/").at(-1) ?? path) =>
  parseEpisode({ path, text: fixtureText(name) });

describe("assembleShow", () => {
  it("sorts episodes by number whatever order they arrive in", () => {
    const { show, diagnostics } = assembleShow("night-ferry", [
      ep("night-ferry/episode-03.txt"),
      ep("night-ferry/episode-01.txt"),
      ep("night-ferry/episode-02.txt"),
    ]);
    expect(show?.episodes.map((e) => e.number)).toEqual([1, 2, 3]);
    expect(diagnostics).toEqual([]);
    expect(showSchema.safeParse(show).success).toBe(true);
  });

  it("rejects two files that claim the same episode", () => {
    const { show, diagnostics } = assembleShow("night-ferry", [
      ep("night-ferry/episode-01.txt"),
      ep("night-ferry/copy/episode-01.txt", "episode-01.txt"),
    ]);
    expect(show?.episodes).toHaveLength(1);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "duplicate-episode",
        severity: "error",
        file: "night-ferry/episode-01.txt",
      }),
    ]);
  });

  it("warns about missing episode numbers", () => {
    const { diagnostics } = assembleShow("night-ferry", [
      ep("night-ferry/episode-01.txt"),
      ep("night-ferry/episode-03.txt"),
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "episode-number-gap",
        message: "Episode numbers are missing: 2.",
      }),
    ]);
  });

  it("returns no show when nothing parsed", () => {
    expect(assembleShow("empty", [{ episode: null, diagnostics: [] }]).show).toBeNull();
  });
});

describe("formatRanges", () => {
  it("compresses runs of numbers", () => {
    expect(formatRanges([2])).toBe("2");
    expect(formatRanges([3, 4, 5, 9, 11, 12])).toBe("3-5, 9, 11-12");
  });
});
