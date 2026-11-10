import { formatTimecode } from "@/domain/screenplay/timecode";
import type { EventKind, Episode, Scene, ScreenplayEvent, Show } from "@/domain/screenplay/schema";

/**
 * A made-up show for the demo and for browser tests. It was written for this
 * project and has nothing to do with any real screenplay.
 */

type RawEvent = [kind: EventKind, startS: number, endS: number, text: string, speaker?: string];
type RawScene = { heading: string; startS: number; endS: number; events: RawEvent[] };

const ms = (seconds: number) => Math.round(seconds * 1000);

function buildEpisode(number: number, rawScenes: RawScene[]): Episode {
  const id = `E${String(number).padStart(3, "0")}`;
  const scenes: Scene[] = [];
  const events: ScreenplayEvent[] = [];
  let line = 6;
  rawScenes.forEach((raw, sceneIndex) => {
    const sceneId = `${id}-S${String(sceneIndex + 1).padStart(2, "0")}`;
    scenes.push({
      id: sceneId,
      number: sceneIndex + 1,
      heading: raw.heading,
      startMs: ms(raw.startS),
      endMs: ms(raw.endS),
      startText: formatTimecode(ms(raw.startS)),
      endText: formatTimecode(ms(raw.endS)),
      line,
    });
    line += 4;
    for (const [kind, startS, endS, text, speaker] of raw.events) {
      const seq = events.length + 1;
      events.push({
        id: `${id}-${String(seq).padStart(4, "0")}`,
        seq,
        sceneId,
        kind,
        startMs: ms(startS),
        endMs: ms(endS),
        startText: formatTimecode(ms(startS)),
        endText: formatTimecode(ms(endS)),
        text,
        ...(speaker ? { speaker, delivery: "on-screen" as const } : {}),
        notes: [],
        line,
        endLine: line + 2,
      });
      line += 4;
    }
  });
  const last = rawScenes.at(-1);
  return {
    id,
    number,
    sourceFile: `night-ferry/episode-${String(number).padStart(2, "0")}.txt`,
    durationMs: ms(last?.endS ?? 0),
    writerNotes: { otherFields: [] },
    scenes,
    events,
  };
}

const EPISODE_ONE: RawScene[] = [
  {
    heading: "EXT. FERRY DECK - NIGHT",
    startS: 0,
    endS: 32,
    events: [
      [
        "camera",
        0,
        5,
        "Wide shot of the ferry cutting through black water, one deck lamp swinging.",
      ],
      ["action", 1, 4.5, "Mara pulls her hood low and slips behind a stack of life rafts."],
      ["sound", 2, 5, "A foghorn groans across the water."],
      ["camera", 5, 10, "Close-up on Mara's hands unfolding a soaked passenger list."],
      ["dialogue", 5.2, 8.4, '"My name was crossed out before I ever came aboard."', "MARA"],
      ["action", 8.4, 10, "She tears the page free and hides it in her sleeve."],
      [
        "camera",
        10,
        15,
        "Medium shot of Captain Oda stepping out of the wheelhouse with a flashlight.",
      ],
      ["dialogue", 10.6, 13.4, '"Nobody walks this deck after midnight."', "CAPTAIN ODA"],
      ["action", 13.4, 16, "The flashlight beam sweeps across the rafts and stops on Mara's boot."],
      ["camera", 15, 20, "Over the shoulder from behind Mara as the light climbs toward her face."],
      ["dialogue", 16.2, 18.8, '"Come out slowly. Both hands."', "CAPTAIN ODA"],
      ["dialogue", 19, 22.6, '"You signed this list, Captain. You knew I would be on it."', "MARA"],
      ["camera", 20, 25, "Close-up on Oda, his jaw tightening."],
      ["dialogue", 23, 26.2, '"Give me the page, and I forget I saw you."', "CAPTAIN ODA"],
      ["sound", 25, 27, "A metal door bangs somewhere below deck."],
      ["camera", 25, 30, "Two-shot as both turn toward the noise."],
      ["dialogue", 27, 29.6, '"Captain! The hold is open, and the cargo is gone!"', "THE PURSER"],
      ["action", 29.6, 32, "Oda grips Mara's wrist and pulls her toward the stairs."],
      ["camera", 30, 32, "Low angle on the stairwell door swinging."],
    ],
  },
  {
    heading: "INT. CARGO HOLD - NIGHT",
    startS: 32,
    endS: 74,
    events: [
      ["camera", 32, 37, "Wide shot of an empty cargo hold, chains still swaying."],
      ["dialogue", 33, 36, '"Twelve crates. Gone between two ports."', "THE PURSER"],
      ["action", 36, 38, "Oda shines the light on a smear of red paint on the floor."],
      ["camera", 37, 42, "Close-up on the smear, shaped like a hand."],
      ["dialogue", 38.4, 41, '"That paint was on your coat."', "CAPTAIN ODA"],
      ["dialogue", 41.2, 44.6, '"Then ask yourself who wanted you to see it."', "MARA"],
      ["camera", 42, 48, "Medium shot of Mara backing against a crate frame."],
      ["action", 44.6, 47, "She slides the torn page into a gap in the hull plating."],
      ["sound", 47, 49, "A low mechanical hum begins under the floor."],
      ["camera", 48, 54, "Slow push in on the Purser, who is quietly smiling."],
      ["dialogue", 49.5, 53, '"You should have stayed off this boat, Mara."', "THE PURSER"],
      ["dialogue", 53.2, 55, '"How do you know my name?"', "MARA"],
      ["camera", 54, 60, "Extreme close-up on Mara's eyes."],
      ["action", 55, 58, "The Purser steps back through the hatch and swings it shut."],
      ["sound", 58, 60, "The lock turns with a heavy clank."],
      ["dialogue", 60, 62.4, '"He has the only key."', "CAPTAIN ODA"],
      ["camera", 60, 66, "Wide shot of Oda and Mara alone as the lights flicker."],
      ["action", 62.4, 66, "Water starts to seep under the hatch."],
      ["dialogue", 66, 69.5, '"Captain, this ship was never going to reach port."', "MARA"],
      ["camera", 66, 74, "Close-up on the water reaching Mara's boots, then the lights go out."],
      ["sound", 70, 74, "Every light in the hold dies with a falling hum."],
    ],
  },
];

const EPISODE_TWO: RawScene[] = [
  {
    heading: "INT. CAPTAIN'S CABIN - NIGHT",
    startS: 0,
    endS: 38,
    events: [
      ["camera", 0, 4, "Close-up on a brass key turning in a cabin lock."],
      ["dialogue", 0.5, 3.5, '"The Purser took the spare. I took this one."', "CAPTAIN ODA"],
      ["action", 3.5, 6, "He pulls a photograph from the ledger and sets it on the desk."],
      [
        "camera",
        4,
        10,
        "Insert shot of the photograph: Mara at nineteen, beside a man in uniform.",
      ],
      ["dialogue", 6.2, 9.4, '"Where did you get that?"', "MARA"],
      ["dialogue", 9.6, 13, '"Your father gave it to me the night he disappeared."', "CAPTAIN ODA"],
      ["camera", 10, 16, "Medium close-up on Mara, breath caught."],
      ["action", 13, 15, "Mara knocks the photograph to the floor."],
      ["dialogue", 15.2, 18.6, '"He did not disappear. You left him in the water."', "MARA"],
      ["camera", 16, 22, "Two-shot across the desk."],
      [
        "dialogue",
        19,
        23.4,
        '"I left him because he told me to. And he told me to find you."',
        "CAPTAIN ODA",
      ],
      ["sound", 23.4, 25.5, "The ship's engine stutters and catches."],
      ["camera", 22, 28, "Close-up on the ledger falling open at a page of names."],
      ["action", 25.5, 28, "Oda turns the ledger around and taps one line."],
      ["dialogue", 28, 31.2, '"Eleven names. Ten of them are already dead."', "CAPTAIN ODA"],
      ["camera", 28, 34, "Slow push in on Mara reading."],
      ["dialogue", 31.4, 34, '"The last one is mine."', "MARA"],
      ["action", 34, 36, "A shadow passes under the cabin door."],
      ["camera", 34, 38, "Low angle on the door handle as it begins to move."],
      ["sound", 36, 38, "The handle rattles once, then stops."],
    ],
  },
  {
    heading: "INT. PASSENGER CORRIDOR - NIGHT",
    startS: 38,
    endS: 68,
    events: [
      ["camera", 38, 44, "Tracking shot down a narrow corridor with doors on both sides."],
      ["action", 39, 42, "Mara runs, one hand along the wall."],
      ["dialogue", 42, 45.6, '"Attention, passengers. A stowaway is aboard."', "THE PURSER"],
      ["camera", 44, 50, "Close-up on a loudspeaker in the ceiling."],
      ["dialogue", 46, 49.4, '"She is armed. Lock your doors."', "THE PURSER"],
      ["action", 49.4, 52, "Cabin doors slam shut one after another."],
      ["sound", 49.4, 52, "A run of doors slamming."],
      ["camera", 50, 56, "Medium shot of an old woman looking through a door chain."],
      ["dialogue", 53, 56, '"In here, child. Quickly."', "OLD WOMAN"],
      ["action", 56, 59, "Mara slips inside. The chain goes back on."],
      ["camera", 56, 62, "Close-up on the woman's coat, smeared with red paint."],
      ["dialogue", 62, 64, '"That paint..."', "MARA"],
      ["dialogue", 64, 67.2, '"We have been expecting you for a very long time."', "OLD WOMAN"],
      ["camera", 62, 68, "Extreme close-up on the old woman's thin smile."],
      ["sound", 66, 68, "The door chain slides quietly into place."],
    ],
  },
];

const EPISODE_THREE: RawScene[] = [
  {
    heading: "INT. ENGINE ROOM - NIGHT",
    startS: 0,
    endS: 36,
    events: [
      ["camera", 0, 5, "Medium shot of Oda wedging a wrench into a seized valve."],
      ["dialogue", 1, 3.8, '"If this goes, we lose the pumps."', "CAPTAIN ODA"],
      ["sound", 3.8, 6, "Steam screams out of a split pipe."],
      ["camera", 5, 10, "Close-up on the pressure dial climbing into the red."],
      ["action", 6, 9, "Oda throws his weight on the wrench."],
      ["dialogue", 9, 12, '"Captain, someone cut the line on purpose!"', "ENGINEER"],
      ["camera", 10, 16, "Wide shot of the engineer holding up a clean-cut hose."],
      ["dialogue", 12.4, 15, '"Who had the keys to this deck?"', "CAPTAIN ODA"],
      ["dialogue", 15.2, 17.4, '"Only you, sir."', "ENGINEER"],
      ["camera", 16, 22, "Slow push in on Oda."],
      ["action", 17.4, 20, "Oda looks down at the key in his own hand."],
      ["dialogue", 20, 23.2, '"Then someone has been wearing my name."', "CAPTAIN ODA"],
      ["camera", 22, 28, "Close-up on a second key, hanging on the Engineer's belt."],
      ["action", 23.2, 26, "The Engineer quietly covers the key with his hand."],
      ["sound", 26, 28, "The pumps cough and fall silent."],
      ["camera", 28, 36, "Medium shot of both men as the deck begins to tilt."],
      ["dialogue", 28.5, 31.5, '"We have twenty minutes. Maybe less."', "ENGINEER"],
      ["dialogue", 32, 35.4, '"Get the lifeboats ready. All but one."', "CAPTAIN ODA"],
    ],
  },
  {
    heading: "EXT. UPPER DECK - DAWN",
    startS: 36,
    endS: 70,
    events: [
      ["camera", 36, 42, "Wide shot of grey dawn over a tilting deck."],
      ["action", 37, 40, "Mara climbs out of a hatch, soaked, holding the ledger."],
      ["dialogue", 40, 43, '"There is one boat left. Why is it locked?"', "MARA"],
      ["camera", 42, 48, "Medium shot of the Purser unbolting a lifeboat."],
      ["dialogue", 43.4, 46.6, '"Because it only seats the people on my list."', "THE PURSER"],
      ["action", 46.6, 49, "He opens the page Mara tore, now taped back together."],
      ["camera", 48, 54, "Close-up on the taped page. Her name is written in again, in fresh ink."],
      ["dialogue", 49.4, 52, '"That is my father\'s handwriting."', "MARA"],
      ["dialogue", 52.2, 55.6, '"Who do you think invited you?"', "THE PURSER"],
      ["camera", 54, 60, "Extreme close-up on Mara, realizing."],
      ["sound", 56, 58, "A distant engine, approaching across the water."],
      ["action", 58, 61, "A second boat appears out of the fog with no lights."],
      ["camera", 60, 70, "Wide shot of the second boat closing on the ferry."],
      ["dialogue", 64, 67, '"Father?"', "MARA"],
      ["action", 67, 70, "A figure at the bow slowly lifts a hand."],
    ],
  },
];

export const DEMO_SHOW: Show = {
  title: "Night Ferry (made up for this demo)",
  episodes: [
    buildEpisode(1, EPISODE_ONE),
    buildEpisode(2, EPISODE_TWO),
    buildEpisode(3, EPISODE_THREE),
  ],
};
