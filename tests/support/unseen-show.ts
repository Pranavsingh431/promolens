import { buildZip } from "./zip-builder";

/**
 * A made-up show that no test fixture, prompt, or tuning run has ever used. It
 * proves the backend handles a ZIP it has never seen.
 */

const CAST = ["ILSA", "THE KEEPER", "DOCTOR VANE"] as const;
const LINES = [
  "The tide tables were changed by hand.",
  "Nobody signs for the salt after midnight.",
  "You counted the lamps twice. Why?",
  "The archive door was open when I came in.",
  "Burn the third ledger before the boat comes.",
  "She was on the pier an hour before the storm.",
  "That name was struck out in red ink.",
  "If he reads it, we are finished.",
] as const;
const ACTIONS = [
  "Ilsa slides a brass key under the map table.",
  "The keeper turns the lamp toward the stairwell.",
  "Doctor Vane closes the shutters one by one.",
  "A wet envelope lands on the counter.",
] as const;
const SHOTS = ["Close-up on the ledger's torn spine.", "Slow pan across the empty archive."];
const SOUNDS = ["A bell rings once out on the water.", "Rain hammers the skylight."];

const clock = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
};

/** A made-up word, the same for the same seed, so varied shows stay reproducible. */
function word(seed: number): string {
  const syllables = ["ka", "ro", "mi", "tel", "su", "van", "dor", "pe", "lis", "qua", "zen", "bo"];
  let n = (seed * 2_654_435_761) >>> 0;
  let out = "";
  for (let i = 0; i < 3; i++) {
    out += syllables[n % syllables.length];
    n = Math.floor(n / syllables.length) + 7;
  }
  return out;
}

/** A line nobody else in the show says, for shows whose scenes must not look alike. */
const uniqueLine = (seed: number, index: number) =>
  `The ${word(seed * 97 + index)} took the ${word(seed * 89 + index * 3)} to the ${word(seed * 83 + index * 5)}.`;

function event(index: number, seed: number, start: number, varied = false): string {
  const end = start + 3.5;
  const time = `Start: (${clock(start)}) | End: (${clock(end)})`;
  const pick = <T>(items: readonly T[]) => items[(seed + index) % items.length] as T;
  if (varied && index % 4 !== 2) {
    const speaker = index % 4 === 1 ? `**${pick(CAST)} (Low):**` : "**ACTION:**";
    return `${speaker}\n${time}\n${uniqueLine(seed, index)}`;
  }
  switch (index % 4) {
    case 0:
      return `**ACTION:**\n${time}\n${pick(ACTIONS)}`;
    case 1:
      return `**${pick(CAST)} (Low):**\n${time}\n"${pick(LINES)} (${seed}.${index})"`;
    case 2:
      return `**CAMERA:**\n${time}\n${pick(SHOTS)}`;
    default:
      return `**SOUND FX:**\n${time}\n${pick(SOUNDS)}`;
  }
}

/** A small number from the show's name, so two shows differ in what they say. */
const saltOf = (name: string) => [...name].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 9973, 7);

function episodeText(number: number, showName: string, varied = false): string {
  const salt = saltOf(showName);
  const scenes = [0, 1, 2].map((sceneIndex) => {
    const from = sceneIndex * 44;
    const events = Array.from({ length: 11 }, (_, i) =>
      event(i, salt + number * 10 + sceneIndex, from + i * 4, varied),
    );
    return [
      `SCENE ${String(sceneIndex + 1).padStart(2, "0")}`,
      `Scene heading: INT. SALT ARCHIVE – NIGHT`,
      `Scene start: ${clock(from)}`,
      `Scene end: ${clock(from + 44)}`,
      "",
      "Actions and dialogue:",
      "",
      events.join("\n\n"),
    ].join("\n");
  });
  return [
    `EPISODE NUMBER: Episode ${number}`,
    "EPISODE LOGLINE: A forged tide table points to a crime on the island.",
    "CONTINUITY NOTES: Made up for tests.",
    "",
    "--- SCRIPT START ---",
    "",
    scenes.join("\n\n"),
    "",
    "--- SCRIPT END ---",
    "",
  ].join("\n");
}

export function unseenShowEntries(episodes = 5, showName = "the-salt-archive", varied = false) {
  return Array.from({ length: episodes }, (_, i) => ({
    name: `${showName}/episode-${String(i + 1).padStart(2, "0")}.txt`,
    data: episodeText(i + 1, showName, varied),
  }));
}

/**
 * `varied` gives every scene its own lines, so clips do not read as the same
 * story beat. Benchmarks of the diversity step need that; most tests do not.
 */
export function buildUnseenShowZip(
  episodes = 5,
  showName = "the-salt-archive",
  varied = false,
): Buffer {
  return buildZip(unseenShowEntries(episodes, showName, varied));
}
