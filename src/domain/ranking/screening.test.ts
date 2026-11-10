import { describe, expect, it } from "vitest";

import { fakeScreen, ferryTimeline, makeCandidate } from "../../../tests/support/ranking";
import { DEFAULT_RANKING_CONFIG } from "./config";
import {
  boundaryEstimate,
  screenDeterministic,
  screenPriority,
  selectForAssessment,
  type ScreenEntry,
} from "./screening";

const CONFIG = DEFAULT_RANKING_CONFIG;

describe("Stage A removes only clips that cannot be shown", () => {
  it("passes a legal clip and flags a cut line", () => {
    const [a] = screenDeterministic(
      [makeCandidate(ferryTimeline, [{ episode: 1, startMs: 5_000, endMs: 30_000 }])],
      ferryTimeline,
      CONFIG,
    );
    expect(a).toMatchObject({ pass: true, reasons: [] });
    expect(a?.flags).toContain("cuts-line-at-end");
  });

  it("removes an exact repeat of an earlier clip and keeps the first", () => {
    const clip = makeCandidate(ferryTimeline, [{ episode: 1, startMs: 4_500, endMs: 26_000 }]);
    const copy = { ...clip, id: `cues:${clip.clipKey}`, method: "cues" };
    const [first, second] = screenDeterministic([clip, copy], ferryTimeline, CONFIG);
    expect(first?.pass).toBe(true);
    expect(second).toMatchObject({ pass: false, reasons: ["duplicate-interval"] });
  });

  it("removes clips with structural errors", () => {
    const tooShort = makeCandidate(ferryTimeline, [{ episode: 1, startMs: 4_500, endMs: 14_000 }]);
    const [a] = screenDeterministic([tooShort], ferryTimeline, CONFIG);
    expect(a?.pass).toBe(false);
    expect(a?.reasons).toContain("duration-out-of-range");
  });

  it("flags a clip whose opening has only a camera direction", () => {
    // Episode 2 from 12.0 s opens on a long wide shot with nothing said or done.
    const [a] = screenDeterministic(
      [makeCandidate(ferryTimeline, [{ episode: 2, startMs: 12_000, endMs: 37_000 }])],
      ferryTimeline,
      CONFIG,
    );
    expect(a?.pass).toBe(true);
    expect(a?.flags).toContain("quiet-opening");
  });
});

describe("screening priority", () => {
  it("is the weighted rubric on the quick ratings, with a boundary estimate", () => {
    const quick = fakeScreen("", { hook: 4, cliffhanger: 4, clarity: 4, emotion: 4 });
    expect(screenPriority(quick, [], CONFIG.weights)).toBe(97.5);
    expect(boundaryEstimate([])).toBe(3);
  });
});

const entry = (
  id: string,
  episode: number,
  priority: number | null,
  momentType: ScreenEntry["momentType"] = "confrontation",
): ScreenEntry => ({ candidateId: id, clipKey: id, episode, priority, momentType });

describe("selection for detailed assessment", () => {
  const entries = [
    entry("a", 1, 90),
    entry("b", 1, 85),
    entry("c", 1, 80),
    entry("d", 2, 40),
    entry("e", 3, 70, "quiet-tension"),
    entry("f", 3, 60, "quiet-tension"),
    entry("g", 3, 65),
    entry("h", 3, null),
  ];
  const config = { ...CONFIG.screening, shortlist: 2, perTypeFloor: 1, explore: 0 };

  it("takes the top by priority, then each episode's best and each moment type's best", () => {
    const { selected, excluded } = selectForAssessment(entries, config);
    const reasons = Object.fromEntries(selected.map((s) => [s.candidateId, s.reason]));
    expect(reasons).toEqual({
      a: "priority",
      b: "priority",
      e: "episode-floor",
      d: "episode-floor",
      h: "screen-failed",
    });
    expect(excluded.map((e) => e.candidateId)).toEqual(["c", "g", "f"]);
  });

  it("adds the best of a moment type the priority cut missed", () => {
    const { selected } = selectForAssessment(
      [entry("a", 1, 90), entry("b", 1, 85), entry("q", 1, 20, "visual-or-action")],
      { ...config, episodeFloor: false },
    );
    expect(selected.find((s) => s.candidateId === "q")?.reason).toBe("type-floor");
  });

  it("keeps a clip whose quick read failed instead of dropping it", () => {
    const { selected } = selectForAssessment([entry("x", 1, null)], config);
    expect(selected).toEqual([{ candidateId: "x", reason: "screen-failed", priorityRank: null }]);
  });

  it("draws the same exploration sample every time, whatever the input order", () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(`k${i}`, 1, 100 - i));
    const explore = { ...config, shortlist: 5, episodeFloor: false, perTypeFloor: 0, explore: 4 };
    const first = selectForAssessment(many, explore);
    const again = selectForAssessment([...many].reverse(), explore);
    expect(first).toEqual(again);
    expect(first.selected.filter((s) => s.reason === "exploration")).toHaveLength(4);
    expect(first.excluded).toHaveLength(21);
  });
});
