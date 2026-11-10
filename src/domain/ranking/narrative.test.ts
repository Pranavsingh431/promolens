import { describe, expect, it } from "vitest";

import { narrativeSimilarity, narrativeVectors, type NarrativeVectors } from "./narrative";

const similarityOf = (vectors: Map<string, NarrativeVectors>, a: string, b: string) =>
  narrativeSimilarity(vectors.get(a) as NarrativeVectors, vectors.get(b) as NarrativeVectors);

const filler = (i: number) => ({
  id: `f${i}`,
  story: `Scene ${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"][i]} unfolds quietly.`,
  description: `A ${["market", "harbor", "attic", "orchard", "bakery", "stable"][i]} visit.`,
});

describe("narrative similarity", () => {
  it("finds the same incident described in different words", () => {
    const vectors = narrativeVectors([
      {
        id: "a",
        story: "He lunges. She gasps.",
        description: "A glowing iron stops inches from Lena's face as she trembles.",
      },
      {
        id: "b",
        story: "The door slams. A chain rattles.",
        description: "The glowing iron nears Lena's trembling face and stops inches away.",
      },
      ...Array.from({ length: 6 }, (_, i) => filler(i)),
    ]);
    expect(similarityOf(vectors, "a", "b")).toBeGreaterThan(0.5);
    expect(similarityOf(vectors, "a", "f1")).toBe(0);
  });

  it("finds a literal recap through the story text alone", () => {
    const line = "You swore the deed was burned. I found the deed in the cellar.";
    const vectors = narrativeVectors([
      { id: "first", story: line, description: "An accusation." },
      { id: "recap", story: line, description: "A flashback opens the next episode." },
      ...Array.from({ length: 6 }, (_, i) => filler(i)),
    ]);
    expect(similarityOf(vectors, "first", "recap")).toBeGreaterThan(0.9);
  });

  it("gives words found in every clip no weight, so boilerplate cannot match clips", () => {
    const docs = ["a", "b", "c"].map((id) => ({
      id,
      story: "Mara and Kade argue again.",
      description: "A voice calls out in the dark.",
    }));
    const vectors = narrativeVectors(docs);
    expect(similarityOf(vectors, "a", "b")).toBe(0);
  });

  it("handles empty text and a single clip", () => {
    const vectors = narrativeVectors([{ id: "only", story: "", description: "" }]);
    expect(similarityOf(vectors, "only", "only")).toBe(0);
  });

  it("does not depend on input order", () => {
    const docs = [
      { id: "a", story: "Rain hits the glass.", description: "A letter burns on the stove." },
      { id: "b", story: "Boots on gravel.", description: "The letter burns while she watches." },
      { id: "c", story: "A bell rings twice.", description: "A stranger asks for directions." },
    ];
    const forward = narrativeVectors(docs);
    const backward = narrativeVectors([...docs].reverse());
    expect(similarityOf(forward, "a", "b")).toBeCloseTo(similarityOf(backward, "b", "a"), 12);
  });
});
