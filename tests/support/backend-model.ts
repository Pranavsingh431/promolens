import { chatReply, type ChatHandler } from "./mock-openrouter";
import { fakeCold, fakeEditorial, fakePair, fakeScreen } from "./ranking";

/**
 * Deterministic answers for every model stage, so the real parsing, discovery,
 * resolution, and ranking code runs end to end with no paid call. The answers
 * cite events that are really in the prompt.
 */

function proposals(user: string) {
  const seqs = [...user.matchAll(/^#(\d+) /gm)].map((match) => Number(match[1]));
  const clip = (from: number, length: number) => {
    const startEvent = seqs[from] as number;
    const endEvent = seqs[Math.min(from + length, seqs.length - 1)] as number;
    return {
      startEvent,
      endEvent,
      hookEvents: [startEvent],
      cliffhangerEvents: [endEvent],
      supportingEvents: [],
      hookType: "curiosity",
      hook: "Something is wrong from the first second.",
      cliffhanger: "The question stays open.",
      whyItWorks: "A clear threat and an unanswered question.",
      contextNeeded: [],
      warnings: [],
    };
  };
  const count = Math.floor(seqs.length / 9);
  return {
    episodeNotes: "Two strong turns.",
    proposals: Array.from({ length: Math.min(count, 3) }, (_, i) => clip(i * 9, 8)),
  };
}

export const answerEveryStage: ChatHandler = (body) => {
  const user = body.messages[1]?.content ?? "";
  const name = (body.response_format as { json_schema?: { name?: string } } | undefined)
    ?.json_schema?.name;
  if (name === "promo_screen") return chatReply(fakeScreen(user));
  if (name === "cold_viewer") return chatReply(fakeCold(user));
  if (name === "editorial_judgment") return chatReply(fakeEditorial(user));
  if (name === "pairwise_judgment") return chatReply(fakePair());
  return chatReply(proposals(user));
};

const hashOf = (text: string) => [...text].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);

/**
 * Judgments that differ per clip, as real ones do: about one clip in five fails
 * an essential gate (the supplied pack: 23 of 118), and descriptions differ, so
 * the diversity step sees distinct clips.
 */
export const answerVaried: ChatHandler = (body) => {
  const user = body.messages[1]?.content ?? "";
  const name = (body.response_format as { json_schema?: { name?: string } } | undefined)
    ?.json_schema?.name;
  const h = hashOf(user);
  if (name === "editorial_judgment") {
    const base = fakeEditorial(user);
    const rating = h % 5 === 0 ? 1 : 2 + (h % 3);
    return chatReply({
      ...base,
      hook: { ...base.hook, rating, opening: `Opening ${h % 9973} turns.` },
      cliffhanger: { ...base.cliffhanger, rating: 2 + ((h >> 3) % 3), ending: `Ends ${h % 7919}.` },
    });
  }
  if (name === "cold_viewer") {
    const base = fakeCold(user);
    return chatReply({ ...base, happening: { ...base.happening, text: `Event ${h % 6007}.` } });
  }
  return answerEveryStage(body);
};
