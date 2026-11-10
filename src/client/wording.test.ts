import { describe, expect, it } from "vitest";

import {
  CONTENT_WARNINGS,
  FALSE_CLIFFHANGERS,
  TENSION_TYPES,
} from "@/domain/ranking/prompts/editorial-v1";
import { STRUCTURAL_SEVERITY } from "@/domain/evaluation/structural-checks";

import {
  TIER_LABEL,
  describeLowered,
  describeReview,
  describeTension,
  describeWarning,
} from "./wording";

const looksLikeCode = (text: string) => /[a-z]+-[a-z]+-[a-z]+/.test(text);

describe("editor wording", () => {
  const flags = [
    "cuts-line-at-start",
    "cuts-line-at-end",
    "grazes-line-at-start",
    "grazes-line-at-end",
    "quiet-opening",
    "quiet-ending",
    "hook-needs-prior-context",
    "essential-context-missing",
    "cold-viewer-claims-without-evidence",
    "model-cited-unknown-events",
    "model-cited-events-outside-window",
    "model-quote-not-in-clip",
    ...CONTENT_WARNINGS,
    ...FALSE_CLIFFHANGERS.filter((f) => f !== "none").map((f) => `possible-false-cliffhanger:${f}`),
    ...Object.entries(STRUCTURAL_SEVERITY)
      .filter(([, severity]) => severity === "warning")
      .map(([code]) => code),
  ];

  it.each(flags)("has real wording for %s", (code) => {
    const note = describeWarning(code);
    expect(note.detail).not.toBe("Check this before posting.");
    expect(looksLikeCode(note.label)).toBe(false);
  });

  it("describes every review reason and every tension", () => {
    for (const code of [
      "hook-at-the-minimum",
      "cliffhanger-at-the-minimum",
      "clarity-at-the-minimum",
    ]) {
      expect(describeReview(code).detail).not.toBe("Check this before posting.");
    }
    expect(describeReview("comparison-refused:2").label).toBe("Comparison missing");
    for (const tension of TENSION_TYPES)
      expect(looksLikeCode(describeTension(tension))).toBe(false);
  });

  it("explains every reason a rating can be lowered", () => {
    for (const code of [
      "no-hook-evidence-in-opening",
      "no-cliffhanger-evidence-in-ending",
      "nothing-left-unresolved",
      "mostly-partial-understanding",
      "false-cliffhanger:no-clear-issue",
    ]) {
      expect(looksLikeCode(describeLowered(code))).toBe(false);
    }
  });

  it("still shows an unknown code in readable form rather than hiding it", () => {
    expect(describeWarning("brand-new-warning").label).toBe("Brand new warning");
  });

  it("never describes a score as a chance of going viral", () => {
    const text = JSON.stringify([TIER_LABEL, flags.map(describeWarning)]);
    expect(text).not.toMatch(/viral|probab|likely to perform/i);
  });
});
