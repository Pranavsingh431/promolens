import { describe, expect, it } from "vitest";

import { episodeSchema, eventSchema } from "./schema";

const camera = {
  id: "E001-0001",
  seq: 1,
  sceneId: "E001-S01",
  kind: "camera",
  startMs: 0,
  endMs: 4_500,
  startText: "00:00.00",
  endText: "00:04.50",
  text: "Wide shot of a harbor.",
  notes: [],
  line: 14,
  endLine: 16,
} as const;

const line = {
  ...camera,
  id: "E001-0002",
  seq: 2,
  kind: "dialogue",
  speaker: "ANA",
  delivery: "on-screen",
  text: '"Run."',
} as const;

describe("eventSchema", () => {
  it("accepts camera and dialogue events", () => {
    expect(eventSchema.safeParse(camera).success).toBe(true);
    expect(eventSchema.safeParse(line).success).toBe(true);
  });

  it("requires a speaker and delivery for dialogue only", () => {
    expect(eventSchema.safeParse({ ...line, speaker: undefined }).success).toBe(false);
    expect(eventSchema.safeParse({ ...camera, speaker: "ANA" }).success).toBe(false);
    expect(eventSchema.safeParse({ ...camera, delivery: "voice-over" }).success).toBe(false);
  });

  it("rejects reversed times, fractional milliseconds, and malformed ids", () => {
    expect(eventSchema.safeParse({ ...camera, endMs: 100, startMs: 200 }).success).toBe(false);
    expect(eventSchema.safeParse({ ...camera, startMs: 0.5 }).success).toBe(false);
    expect(eventSchema.safeParse({ ...camera, id: "camera-1" }).success).toBe(false);
    expect(eventSchema.safeParse({ ...camera, id: "E002-0001" }).success).toBe(false);
  });
});

describe("episodeSchema", () => {
  const episode = {
    id: "E001",
    number: 1,
    sourceFile: "show/episode-01.txt",
    durationMs: 20_000,
    writerNotes: { otherFields: [] },
    scenes: [
      {
        id: "E001-S01",
        number: 1,
        heading: "EXT. HARBOR - DAY",
        startMs: 0,
        endMs: 20_000,
        startText: "00:00.00",
        endText: "00:20.00",
        line: 7,
      },
    ],
    events: [camera, line],
  };

  it("accepts a consistent episode", () => {
    expect(episodeSchema.safeParse(episode).success).toBe(true);
  });

  it("rejects events that point at a missing scene or break source order", () => {
    expect(
      episodeSchema.safeParse({ ...episode, events: [{ ...camera, sceneId: "E001-S09" }] }).success,
    ).toBe(false);
    expect(episodeSchema.safeParse({ ...episode, events: [line, camera] }).success).toBe(false);
  });

  it("requires at least one scene", () => {
    expect(episodeSchema.safeParse({ ...episode, scenes: [], events: [] }).success).toBe(false);
  });
});
