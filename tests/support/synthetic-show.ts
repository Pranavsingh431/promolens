import { createRandom } from "../../src/domain/evaluation/random";
import type { Episode, Scene, ScreenplayEvent, Show } from "../../src/domain/screenplay/schema";

/**
 * Builds parsed shows directly, for tests that need many episodes. All text
 * is placeholder text. Camera shots tile each episode; dialogue lines and
 * actions sit inside them; some lines end in "?" or "!".
 */
export function syntheticShow(options: {
  episodes: number;
  seed?: number;
  minDurationMs?: number;
  maxDurationMs?: number;
}): Show {
  const random = createRandom(options.seed ?? 1);
  const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const episodes: Episode[] = [];

  for (let number = 1; number <= options.episodes; number++) {
    const id = `E${String(number).padStart(3, "0")}`;
    const durationMs =
      between((options.minDurationMs ?? 70_000) / 10, (options.maxDurationMs ?? 200_000) / 10) * 10;
    const cut = Math.round((durationMs * between(30, 70)) / 1000) * 10;
    const scenes: Scene[] = [
      {
        id: `${id}-S01`,
        number: 1,
        heading: "INT. ROOM - DAY",
        startMs: 0,
        endMs: cut,
        startText: "x",
        endText: "x",
        line: 1,
      },
      {
        id: `${id}-S02`,
        number: 2,
        heading: "EXT. STREET - NIGHT",
        startMs: cut,
        endMs: durationMs,
        startText: "x",
        endText: "x",
        line: 2,
      },
    ];
    const sceneAt = (ms: number) => (ms < cut ? `${id}-S01` : `${id}-S02`);
    const raw: Array<Omit<ScreenplayEvent, "id" | "seq" | "line" | "endLine">> = [];
    const add = (
      kind: ScreenplayEvent["kind"],
      startMs: number,
      endMs: number,
      text: string,
      speaker?: string,
    ) =>
      raw.push({
        sceneId: sceneAt(startMs),
        kind,
        startMs,
        endMs,
        startText: "x",
        endText: "x",
        text,
        notes: [],
        ...(speaker ? { speaker, delivery: "on-screen" as const } : {}),
      });

    for (let t = 0; t < durationMs;) {
      const end = Math.min(durationMs, t + between(250, 600) * 10);
      add("camera", t, end, `Shot ${raw.length + 1}.`);
      t = end;
    }
    for (let t = between(0, 600) * 10; t < durationMs - 2_000; t += between(200, 450) * 10) {
      const end = Math.min(durationMs, t + between(120, 300) * 10);
      const ending = random() < 0.25 ? "?" : random() < 0.2 ? "!" : ".";
      add("dialogue", t, end, `"Line ${raw.length + 1}${ending}"`, random() < 0.5 ? "ANA" : "BEN");
    }
    for (let t = between(500, 1500) * 10; t < durationMs - 3_000; t += between(1500, 3000) * 10) {
      add(
        "action",
        t,
        t + 2_000,
        random() < 0.5 ? "She grabs the letter." : "He waits by the door.",
      );
    }

    const events = raw
      .sort((a, b) => a.startMs - b.startMs || a.kind.localeCompare(b.kind))
      .map((event, index) => ({
        ...event,
        id: `${id}-${String(index + 1).padStart(4, "0")}`,
        seq: index + 1,
        line: index + 10,
        endLine: index + 10,
      }));

    episodes.push({
      id,
      number,
      sourceFile: `synthetic/episode-${number}.txt`,
      durationMs,
      writerNotes: { logline: "SYNTHETIC LOGLINE SPOILER", otherFields: [] },
      scenes,
      events,
    });
  }
  return { title: "synthetic", episodes };
}
