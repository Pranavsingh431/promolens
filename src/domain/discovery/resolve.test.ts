import { describe, expect, it } from "vitest";

import { fixtureText } from "../../../tests/support/fixtures";
import { checkCandidate } from "../evaluation/structural-checks";
import { parseEpisode } from "../screenplay/parse-episode";
import type { Episode } from "../screenplay/schema";
import { formatTimecode } from "../screenplay/timecode";
import { createTimeline } from "../screenplay/timeline";
import type { Proposal } from "./proposal";
import { resolveProposals } from "./resolve";

const OPTIONS = { method: "ai-test", methodVersion: "test" };

function load(text: string) {
  const episode = parseEpisode({ path: "x/episode-01.txt", text }).episode as Episode;
  return { episode, timeline: createTimeline({ title: "t", episodes: [episode] }) };
}

/** Builds a one-scene episode from [label, startMs, endMs, text] blocks in this order. */
function build(durationMs: number, blocks: Array<[string, number, number, string]>) {
  const t = (ms: number) => formatTimecode(ms);
  return load(
    [
      "EPISODE NUMBER: Episode 1",
      "--- SCRIPT START ---",
      "SCENE 01",
      "Scene heading: INT. HALL - DAY",
      "Scene start: 00:00.00",
      `Scene end: ${t(durationMs)}`,
      "",
      ...blocks.flatMap(([label, s, e, text]) => [
        `**${label}:**`,
        `Start: (${t(s)}) | End: (${t(e)})`,
        text,
        "",
      ]),
      "--- SCRIPT END ---",
    ].join("\n"),
  );
}

const proposal = (overrides: Partial<Proposal>): Proposal => ({
  startEvent: 3,
  endEvent: 15,
  hookEvents: [4],
  cliffhangerEvents: [15],
  supportingEvents: [],
  hookType: "curiosity",
  hook: "h",
  cliffhanger: "c",
  whyItWorks: "w",
  contextNeeded: [],
  warnings: [],
  ...overrides,
});

const ferry = load(fixtureText("episode-01.txt"));
const resolve = (proposals: Proposal[], data = ferry) =>
  resolveProposals({ proposals, episodeNotes: "" }, data.episode, data.timeline, OPTIONS);
const one = (p: Partial<Proposal>, data = ferry) => resolve([proposal(p)], data).outcomes[0];

describe("timestamps come only from the cited events", () => {
  it("turns anchors into exact times and nudges the end onto the shot change", () => {
    // #3 starts at 00:04.50 and #15 ends at 00:31.50; the camera shot over it ends at 00:32.00.
    const { outcomes, candidates } = resolve([proposal({})]);
    expect(outcomes[0]).toMatchObject({
      status: "accepted",
      proposed: { episode: 1, startMs: 4_500, endMs: 31_500 },
      final: { episode: 1, startMs: 4_500, endMs: 32_000 },
      adjustments: [
        { segment: 0, edge: "end", fromMs: 31_500, toMs: 32_000, reason: "end-snapped-to-shot" },
      ],
      flags: [],
      refs: {
        start: "E001-0003",
        end: "E001-0015",
        hook: ["E001-0004"],
        cliffhanger: ["E001-0015"],
      },
    });
    expect(candidates[0]).toMatchObject({
      id: "ai-test:E001@0004500-0032000",
      method: "ai-test",
      score: null,
    });
    expect(candidates[0]?.cues).toEqual(["hook:curiosity"]);
    expect(
      checkCandidate(candidates[0]!, ferry.timeline).filter((i) => i.severity === "error"),
    ).toEqual([]);
  });

  it("keeps a proposal with valid anchors but records event numbers that do not exist", () => {
    expect(one({ supportingEvents: [99, 4] })).toMatchObject({
      status: "accepted",
      unknownRefs: [99],
      refs: { supporting: ["E001-0004"] },
    });
  });

  it("counts zero and negative event numbers as unknown references", () => {
    expect(one({ supportingEvents: [0, -2, 4] })).toMatchObject({
      status: "accepted",
      unknownRefs: [-2, 0],
    });
  });

  it.each<[Partial<Proposal>, string]>([
    [{ startEvent: 99 }, "unknown-anchor"],
    [{ startEvent: 0 }, "unknown-anchor"],
    [{ startEvent: 15, endEvent: 3 }, "reversed-anchors"],
    [{ hookEvents: [98] }, "no-valid-hook-ref"],
    [{ cliffhangerEvents: [] }, "no-valid-cliffhanger-ref"],
  ])("rejects %j as %s", (overrides, reason) => {
    expect(one(overrides)).toMatchObject({ status: "rejected", reason });
  });
});

describe("the hook stays in the first three seconds", () => {
  it("trims setup before a late hook, then avoids cutting a spoken line", () => {
    // Hook #7 starts at 00:10.00. The shot change before it is 00:09.00, which falls inside line #5
    // (00:07.40 to 00:09.60), so the start moves back to 00:07.40, still 2.6 s before the hook.
    expect(one({ startEvent: 1, hookEvents: [7] })).toMatchObject({
      status: "accepted",
      final: { startMs: 7_400, endMs: 32_000 },
      adjustments: [
        { edge: "start", fromMs: 0, toMs: 9_000, reason: "start-trimmed-to-hook" },
        { edge: "start", fromMs: 9_000, toMs: 7_400, reason: "start-extended-to-whole-line" },
        { edge: "end", fromMs: 31_500, toMs: 32_000, reason: "end-snapped-to-shot" },
      ],
      flags: [],
    });
  });

  it("keeps setup the model marked as needed, and flags the late hook", () => {
    expect(one({ startEvent: 1, hookEvents: [7], supportingEvents: [2] })).toMatchObject({
      status: "accepted",
      final: { startMs: 0, endMs: 32_000 },
      flags: ["late-hook"],
    });
  });

  it("widens the clip when the hook starts before the start anchor", () => {
    expect(one({ startEvent: 4, hookEvents: [3] })).toMatchObject({
      final: { startMs: 4_500, endMs: 32_000 },
      adjustments: [
        { edge: "start", fromMs: 5_200, toMs: 4_500, reason: "start-moved-to-include-hook" },
        { edge: "end", fromMs: 31_500, toMs: 32_000, reason: "end-snapped-to-shot" },
      ],
    });
  });
});

describe("the clip ends on the cliffhanger", () => {
  it("drops content after the cliffhanger, and rejects the clip if too little is left", () => {
    // Ending on #8 (ends 00:13.80) leaves 9.3 s. Nothing earlier fits the hook window and only
    // 1.2 s of tail without a new line can be added, so the proposal is rejected, not reshaped.
    expect(one({ endEvent: 16, cliffhangerEvents: [8] })).toMatchObject({
      status: "rejected",
      reason: "too-short",
      detail: "Only 10.5 s fit around the hook and the ending.",
    });
  });

  it("keeps later content the model marked as needed, and flags it", () => {
    expect(one({ endEvent: 16, cliffhangerEvents: [8], supportingEvents: [13] })).toMatchObject({
      status: "accepted",
      final: { startMs: 4_500, endMs: 45_000 },
      flags: ["content-after-cliffhanger"],
    });
  });
});

describe("clip length", () => {
  const long = build(90_000, [
    ["CAMERA", 0, 10_000, "Shot."],
    ["ANA", 2_000, 4_000, '"First?"'],
    ["CAMERA", 10_000, 20_000, "Shot."],
    ["BEN", 15_000, 17_000, '"Second."'],
    ["CAMERA", 20_000, 30_000, "Shot."],
    ["CAMERA", 30_000, 40_000, "Shot."],
    ["ACTION", 30_000, 32_000, "He grabs the knife."],
    ["CAMERA", 40_000, 50_000, "Shot."],
    ["ANA", 40_000, 42_000, '"Third!"'],
    ["CAMERA", 50_000, 60_000, "Shot."],
    ["CAMERA", 60_000, 70_000, "Shot."],
    ["CAMERA", 70_000, 80_000, "Shot."],
    ["BEN", 70_000, 72_000, '"Fourth."'],
    ["CAMERA", 80_000, 90_000, "Shot."],
    ["ANA", 85_000, 87_000, '"Last?"'],
  ]);

  it("rejects a clip whose hook-to-ending stretch alone is over 60 s", () => {
    expect(
      one({ startEvent: 1, endEvent: 15, hookEvents: [4], cliffhangerEvents: [15] }, long),
    ).toMatchObject({
      status: "rejected",
      reason: "too-long",
      detail: "Hook to ending alone runs 72.0 s.",
    });
  });

  it("drops kept setup to fit 60 s, cutting at an event edge and never touching the ending", () => {
    expect(
      one(
        {
          startEvent: 1,
          endEvent: 15,
          hookEvents: [9],
          cliffhangerEvents: [15],
          supportingEvents: [2],
        },
        long,
      ),
    ).toMatchObject({
      status: "accepted",
      final: { startMs: 30_000, endMs: 87_000 },
      adjustments: [{ edge: "start", fromMs: 0, toMs: 30_000, reason: "start-trimmed-to-fit-60s" }],
      flags: ["late-hook"],
    });
  });

  const short = (actionStart: number) =>
    build(30_000, [
      ["CAMERA", 0, 5_000, "Shot."],
      ["ACTION", actionStart, 5_000, "She turns."],
      ["CAMERA", 5_000, 12_000, "Shot."],
      ["ANA", 5_000, 8_000, '"Why?"'],
      ["CAMERA", 12_000, 22_000, "Shot."],
      ["BEN", 18_000, 21_000, '"Because."'],
      ["CAMERA", 22_000, 30_000, "Shot."],
      ["ACTION", 22_500, 23_500, "She stares."],
      ["ANA", 25_000, 27_000, '"No."'],
    ]);

  it("adds context inside the hook window and a short tail to reach 20 s", () => {
    expect(
      one({ startEvent: 4, endEvent: 6, hookEvents: [4], cliffhangerEvents: [6] }, short(2_000)),
    ).toMatchObject({
      status: "accepted",
      final: { startMs: 2_000, endMs: 22_000 },
      adjustments: [
        { edge: "start", fromMs: 5_000, toMs: 2_000, reason: "start-extended-for-length" },
        { edge: "end", fromMs: 21_000, toMs: 22_000, reason: "end-extended-for-length" },
      ],
    });
  });

  it("rejects a short clip rather than stretching it past its hook or ending", () => {
    expect(
      one({ startEvent: 4, endEvent: 6, hookEvents: [4], cliffhangerEvents: [6] }, short(3_000)),
    ).toMatchObject({
      status: "rejected",
      reason: "too-short",
      detail: "Only 19.0 s fit around the hook and the ending.",
    });
  });
});

describe("spoken lines", () => {
  it("flags a cut through a line when fixing it would push the hook out of the first 3 s", () => {
    const data = build(40_000, [
      ["CAMERA", 0, 30_000, "Shot."],
      ["ANA", 0, 16_000, '"A very long speech."'],
      ["BEN", 14_000, 17_000, '"Stop!"'],
      ["CAMERA", 30_000, 40_000, "Shot."],
      ["ANA", 36_000, 38_000, '"Who?"'],
    ]);
    expect(
      one({ startEvent: 3, endEvent: 5, hookEvents: [3], cliffhangerEvents: [5] }, data),
    ).toMatchObject({
      status: "accepted",
      final: { startMs: 14_000, endMs: 38_000 },
      flags: ["cuts-dialogue"],
      adjustments: [],
    });
  });
});

describe("a whole response", () => {
  it("rejects repeats and anything past the per-episode limit, deterministically", () => {
    const thirteen = Array.from({ length: 13 }, () => proposal({}));
    const first = resolve(thirteen);
    expect(first.candidates).toHaveLength(1);
    expect(first.outcomes.map((o) => o.reason ?? o.status)).toEqual([
      "accepted",
      ...Array<string>(11).fill("duplicate-in-response"),
      "beyond-proposal-limit",
    ]);
    expect(resolve(thirteen)).toEqual(first);
  });

  it("accepts an empty response", () => {
    expect(resolve([])).toEqual({ outcomes: [], candidates: [] });
  });
});
