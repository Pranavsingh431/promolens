/**
 * Text similarity for spotting the same story beat in clips that share no
 * footage, such as a scene carried over an episode break or a recap.
 *
 * Each clip gets two vectors: one from its on-screen story text (dialogue,
 * actions, and sounds) and one from the model's own short description of what
 * happens. Serial drama retells a moment in fresh words, so the description
 * catches what the script text misses; the script text catches a literal
 * recap. Terms are weighted by TF-IDF over the clips being compared, so words
 * that appear in every clip (the show's lead names, mostly) count for nothing.
 *
 * This only decides which clips an editor sees side by side. It never changes
 * a clip's score.
 */

export type NarrativeDocument = { id: string; story: string; description: string };
export type NarrativeVector = ReadonlyMap<string, number>;
export type NarrativeVectors = { story: NarrativeVector; description: NarrativeVector };

const STOP_WORDS = new Set(
  (
    "the and but for with from that this these those then than are was were been being " +
    "his her hers him them their she they you your our not does did done have has had " +
    "will would can could should shall may might must just very too over into off about " +
    "again more most some any all one two there here what who whom which when where why how"
  ).split(" "),
);

function tokens(text: string): string[] {
  const words = text.toLowerCase().match(/\p{L}[\p{L}'’]*/gu) ?? [];
  return words
    .map((word) => word.replace(/['’]s$/, ""))
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .map((word) => word.replace(/(ing|ed|es|s)$/, "") || word);
}

function tfIdf(documents: readonly string[][]): Array<Map<string, number>> {
  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    for (const term of new Set(doc)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const n = documents.length;
  return documents.map((doc) => {
    const counts = new Map<string, number>();
    for (const term of doc) counts.set(term, (counts.get(term) ?? 0) + 1);
    const vector = new Map<string, number>();
    for (const [term, count] of counts) {
      // A term in every clip gets weight zero, so it cannot make two clips look alike.
      const weight = (1 + Math.log(count)) * Math.log(n / (documentFrequency.get(term) as number));
      if (weight > 0) vector.set(term, weight);
    }
    const length = Math.sqrt([...vector.values()].reduce((sum, x) => sum + x * x, 0));
    for (const [term, weight] of vector) vector.set(term, weight / length);
    return vector;
  });
}

/** Builds both vectors for every clip. Weights depend on the whole set, so build them together. */
export function narrativeVectors(
  documents: readonly NarrativeDocument[],
): Map<string, NarrativeVectors> {
  const story = tfIdf(documents.map((d) => tokens(d.story)));
  const description = tfIdf(documents.map((d) => tokens(d.description)));
  return new Map(
    documents.map((d, i) => [
      d.id,
      {
        story: story[i] as NarrativeVector,
        description: description[i] as NarrativeVector,
      },
    ]),
  );
}

function cosine(a: NarrativeVector, b: NarrativeVector): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [term, weight] of small) sum += weight * (large.get(term) ?? 0);
  return sum;
}

/** The higher of the two similarities, from 0 (no shared terms) to 1. */
export function narrativeSimilarity(a: NarrativeVectors, b: NarrativeVectors): number {
  return Math.max(cosine(a.story, b.story), cosine(a.description, b.description));
}
