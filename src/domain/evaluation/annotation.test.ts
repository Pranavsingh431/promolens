import { describe, expect, it } from "vitest";

import { NIGHT_FERRY } from "../../../tests/support/fixtures";
import { assembleShow } from "../screenplay/assemble-show";
import { parseEpisode } from "../screenplay/parse-episode";
import type { Show } from "../screenplay/schema";
import { createTimeline } from "../screenplay/timeline";
import {
  annotationFileSchema,
  collectJudgments,
  emptyAnnotationFile,
  mergeAnnotationSave,
  readAnnotationFile,
  validateAnnotations,
  type AnnotationFile,
} from "./annotation";
import type { ReviewItems } from "./review";
import { judgmentSchema } from "./rubric";
import { selectSample } from "./sample";

const show = assembleShow(
  "night-ferry",
  NIGHT_FERRY.map(({ name, text }) => parseEpisode({ path: `night-ferry/${name}`, text })),
).show as Show;
const timeline = createTimeline(show);
const sample = selectSample(show, "b".repeat(64));
const items: ReviewItems = {
  sampleVersion: sample.version,
  seed: 1,
  items: [
    {
      itemId: "B001",
      clipKey: "E001@0000000-0020000",
      segments: [{ episode: 1, startMs: 0, endMs: 20_000 }],
    },
    {
      itemId: "B002",
      clipKey: "E002@0000000-0030000",
      segments: [{ episode: 2, startMs: 0, endMs: 30_000 }],
    },
  ],
};
const context = { sample, timeline, items };

const keep = judgmentSchema.parse({
  ratings: { hook: 3, cliffhanger: 3, clarity: 3, emotion: 2, boundaries: 3 },
  decision: "keep",
  mainReason: "strong-cliffhanger",
  weaknesses: [],
  notes: "",
});
const NOW = "2026-11-10T10:00:00.000Z";
const LATER = "2026-11-10T11:00:00.000Z";

function file(overrides: Partial<AnnotationFile> = {}): AnnotationFile {
  return {
    ...emptyAnnotationFile("R1", sample.version),
    partA: [
      {
        episode: 1,
        status: "complete",
        moments: [
          {
            id: "M-E001-01",
            segments: [{ episode: 1, startMs: 0, endMs: 20_000 }],
            judgment: keep,
            version: 1,
            updatedAt: NOW,
          },
        ],
      },
    ],
    partB: [
      {
        itemId: "B002",
        clipKey: "E002@0000000-0030000",
        judgment: keep,
        version: 1,
        updatedAt: NOW,
      },
    ],
    ...overrides,
  };
}

describe("reading annotation files", () => {
  it("accepts a new empty file", () => {
    expect(annotationFileSchema.safeParse(emptyAnnotationFile("R1", sample.version)).success).toBe(
      true,
    );
  });

  it("explains a file written by a newer version instead of failing obscurely", () => {
    const result = readAnnotationFile({ ...file(), schemaVersion: 2 });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.issues[0]?.message).toMatch(/newer PromoLens/);
  });

  it("rejects reviewer codes that could name another file", () => {
    expect(readAnnotationFile({ ...file(), reviewer: "../R1" }).ok).toBe(false);
    expect(readAnnotationFile({ ...file(), reviewer: "r1" }).ok).toBe(false);
  });
});

describe("validateAnnotations", () => {
  it("accepts a consistent file", () => {
    expect(validateAnnotations(file(), context)).toEqual([]);
  });

  it("rejects moments that break the duration, episode, or sample rules", () => {
    const moments = (
      segments: Array<{ episode: number; startMs: number; endMs: number }>,
      episode = 1,
    ) =>
      file({
        partA: [
          {
            episode,
            status: "in-progress",
            moments: [{ ...file().partA[0]!.moments[0]!, segments }],
          },
        ],
      });

    expect(
      validateAnnotations(moments([{ episode: 1, startMs: 0, endMs: 19_000 }]), context)[0]
        ?.message,
    ).toMatch(/20 to 60 s/);
    expect(
      validateAnnotations(moments([{ episode: 2, startMs: 0, endMs: 30_000 }]), context)[0]
        ?.message,
    ).toMatch(/inside the episode/);
    expect(
      validateAnnotations(moments([{ episode: 7, startMs: 0, endMs: 30_000 }], 7), context)[0]
        ?.message,
    ).toMatch(/not in the sample/);
  });

  it("warns, but does not fail, when a moment cuts through a spoken line", () => {
    const cut = file({
      partA: [
        {
          episode: 1,
          status: "complete",
          moments: [
            {
              ...file().partA[0]!.moments[0]!,
              segments: [{ episode: 1, startMs: 10_500, endMs: 40_000 }],
            },
          ],
        },
      ],
    });
    expect(validateAnnotations(cut, context)).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: "Starts in the middle of a spoken line.",
      }),
    ]);
  });

  it("rejects unknown, mismatched, or repeated review items", () => {
    const review = file().partB[0]!;
    const bad = file({
      partB: [
        { ...review, itemId: "B999" },
        { ...review, clipKey: "E001@0000000-0020000" },
        review,
      ],
    });
    expect(validateAnnotations(bad, context).map((i) => i.message)).toEqual([
      "Review item B999 does not exist.",
      "Review item B002 points at a different clip.",
      "Review item B002 is rated twice.",
    ]);
  });

  it("rejects a file from a different sample", () => {
    expect(validateAnnotations(file({ sampleVersion: "sample-0" }), context)[0]?.path).toBe(
      "sampleVersion",
    );
  });
});

describe("mergeAnnotationSave", () => {
  const existing = { ...file(), revision: 3 };

  it("ignores client versions and only bumps records that changed", () => {
    const moment = existing.partA[0]!.moments[0]!;
    const changed = {
      ...existing.partB[0]!,
      judgment: { ...keep, notes: "Better ending than expected." },
    };
    const reordered = Object.fromEntries(Object.entries(moment).reverse()) as typeof moment;
    const incoming: AnnotationFile = {
      ...existing,
      partA: [
        { ...existing.partA[0]!, moments: [{ ...reordered, version: 99, updatedAt: LATER }] },
      ],
      partB: [
        changed,
        { itemId: "B001", clipKey: "made-up", judgment: keep, version: 7, updatedAt: LATER },
      ],
    };
    const result = mergeAnnotationSave(existing, incoming, { baseRevision: 3, now: LATER, items });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.revision).toBe(4);
    expect(result.file.partA[0]?.moments[0]).toMatchObject({ version: 1, updatedAt: NOW });
    expect(result.file.partB[0]).toMatchObject({ version: 2, updatedAt: LATER });
    expect(result.file.partB[1]).toMatchObject({
      version: 1,
      updatedAt: LATER,
      clipKey: "E001@0000000-0020000",
    });
  });

  it("refuses a save based on an old revision", () => {
    expect(mergeAnnotationSave(existing, existing, { baseRevision: 2, now: LATER, items })).toEqual(
      {
        ok: false,
        conflict: true,
      },
    );
  });
});

describe("collectJudgments", () => {
  it("keeps each reviewer's judgment of the same clip separately", () => {
    const second = { ...file(), reviewer: "R2", partA: [] };
    const { records, completeEpisodes } = collectJudgments([file(), second]);
    expect(
      records.filter((r) => r.source === "part-b").map((r) => [r.reviewer, r.clipKey]),
    ).toEqual([
      ["R1", "E002@0000000-0030000"],
      ["R2", "E002@0000000-0030000"],
    ]);
    expect(completeEpisodes).toEqual([{ reviewer: "R1", episode: 1 }]);
  });
});
