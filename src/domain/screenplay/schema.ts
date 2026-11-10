import { z } from "zod";

/**
 * Canonical screenplay model. The parser builds it once; later stages read it
 * and never reparse raw text.
 *
 * Times are integer milliseconds from the start of the episode. Source times
 * convert exactly, and the original token is kept next to each value.
 *
 * On-screen content (scenes and events) is kept apart from writer metadata
 * (writerNotes), so the cold-viewer check can be given one without the other.
 */

export const msSchema = z.number().int().nonnegative();

const lineSchema = z.number().int().positive();
const episodeIdSchema = z.string().regex(/^E\d{3,}$/);
const sceneIdSchema = z.string().regex(/^E\d{3,}-S\d{2,}$/);
const eventIdSchema = z.string().regex(/^E\d{3,}-\d{4,}$/);

export const EVENT_KINDS = ["camera", "action", "sound", "dialogue"] as const;
export const eventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof eventKindSchema>;

export const deliverySchema = z.enum(["on-screen", "off-screen", "voice-over"]);
export type Delivery = z.infer<typeof deliverySchema>;

export const eventSchema = z
  .object({
    /** Episode plus source position, for example "E007-0042". The same input always gives the same id. */
    id: eventIdSchema,
    /** 1-based position of the block in the episode file. Defines source order. */
    seq: z.number().int().positive(),
    sceneId: sceneIdSchema,
    kind: eventKindSchema,
    startMs: msSchema,
    endMs: msSchema,
    /** Timestamps exactly as written in the source. */
    startText: z.string().min(1),
    endText: z.string().min(1),
    /** Source text with surrounding whitespace removed. Dialogue keeps its quotation marks. */
    text: z.string(),
    /** Dialogue only: the raw label without parentheticals. Not a resolved character name. */
    speaker: z.string().min(1).optional(),
    /** Raw parentheticals from the label, such as delivery notes, "O.S.", or "V.O.". */
    notes: z.array(z.string()),
    /** Dialogue only: derived from the parentheticals. */
    delivery: deliverySchema.optional(),
    /** Line of the label in the source file, and the last line that belongs to the event. */
    line: lineSchema,
    endLine: lineSchema,
  })
  .superRefine((event, ctx) => {
    if (event.endMs < event.startMs) {
      ctx.addIssue({ code: "custom", path: ["endMs"], message: "Event ends before it starts" });
    }
    if (event.endLine < event.line) {
      ctx.addIssue({ code: "custom", path: ["endLine"], message: "Event ends before its label" });
    }
    const isDialogue = event.kind === "dialogue";
    if (isDialogue !== (event.speaker !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["speaker"], message: "Only dialogue has a speaker" });
    }
    if (isDialogue !== (event.delivery !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["delivery"], message: "Only dialogue has a delivery" });
    }
    if (!event.id.startsWith(`${event.sceneId.split("-")[0]}-`)) {
      ctx.addIssue({ code: "custom", path: ["id"], message: "Event and scene ids disagree" });
    }
  });

export const sceneSchema = z
  .object({
    /** Episode plus source position of the scene, for example "E007-S02". */
    id: sceneIdSchema,
    /** Scene number as written. It can repeat or skip; the id does not depend on it. */
    number: z.number().int().nonnegative(),
    /** Raw heading. The three parts below are split from it without normalization. */
    heading: z.string(),
    setting: z.string().optional(),
    location: z.string().optional(),
    timeOfDay: z.string().optional(),
    startMs: msSchema,
    endMs: msSchema,
    /** Null when the source omitted the time and it was derived from the scene's events. */
    startText: z.string().min(1).nullable(),
    endText: z.string().min(1).nullable(),
    line: lineSchema,
  })
  .refine((scene) => scene.endMs >= scene.startMs, {
    message: "Scene ends before it starts",
    path: ["endMs"],
  });

/** Writer metadata. Not on screen and often full of spoilers. */
export const writerNotesSchema = z.object({
  logline: z.string().optional(),
  continuityNotes: z.string().optional(),
  /** Any other header fields, kept as written. */
  otherFields: z.array(z.object({ key: z.string().min(1), value: z.string() })),
});

export const episodeSchema = z
  .object({
    id: episodeIdSchema,
    number: z.number().int().positive(),
    /** Path of the source file inside the archive. */
    sourceFile: z.string().min(1),
    /** End of the last scene. */
    durationMs: msSchema,
    writerNotes: writerNotesSchema,
    scenes: z.array(sceneSchema).min(1),
    /** Every event in source order. Use the timeline index for chronological order. */
    events: z.array(eventSchema),
  })
  .superRefine((episode, ctx) => {
    const sceneIds = new Set(episode.scenes.map((scene) => scene.id));
    if (sceneIds.size !== episode.scenes.length) {
      ctx.addIssue({ code: "custom", path: ["scenes"], message: "Scene ids repeat" });
    }
    episode.events.forEach((event, index) => {
      if (!sceneIds.has(event.sceneId)) {
        ctx.addIssue({ code: "custom", path: ["events", index], message: "Unknown scene id" });
      }
      const previous = episode.events[index - 1];
      if (previous && event.seq <= previous.seq) {
        ctx.addIssue({ code: "custom", path: ["events", index], message: "Not in source order" });
      }
      if (!event.id.startsWith(`${episode.id}-`)) {
        ctx.addIssue({ code: "custom", path: ["events", index], message: "Wrong episode id" });
      }
    });
  });

export const showSchema = z
  .object({
    title: z.string().min(1),
    /** Sorted by episode number. */
    episodes: z.array(episodeSchema).min(1),
  })
  .superRefine((show, ctx) => {
    show.episodes.forEach((episode, index) => {
      const previous = show.episodes[index - 1];
      if (previous && episode.number <= previous.number) {
        ctx.addIssue({
          code: "custom",
          path: ["episodes", index],
          message: "Episodes must be unique and sorted by number",
        });
      }
    });
  });

export type ScreenplayEvent = z.infer<typeof eventSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type WriterNotes = z.infer<typeof writerNotesSchema>;
export type Episode = z.infer<typeof episodeSchema>;
export type Show = z.infer<typeof showSchema>;
