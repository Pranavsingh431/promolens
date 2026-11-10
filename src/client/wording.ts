/**
 * Plain-English wording for the codes in the rank-3 output. Editors should
 * never have to read a code. A code this table does not know is still shown,
 * in readable form, rather than hidden.
 */

export type NoteSeverity = "important" | "content" | "minor";

export type Note = { code: string; label: string; detail: string; severity: NoteSeverity };

const FALSE_CLIFFHANGER: Record<string, string> = {
  "already-answered": "The clip answers its own question before it ends.",
  "conflict-resolved": "The conflict is settled before the clip ends.",
  "no-clear-issue": "Nothing clear is left open at the end.",
  "needs-off-screen-knowledge": "The ending only works for someone who knows the story.",
  "confusing-cut": "The final cut may confuse rather than intrigue.",
};

const WARNINGS: Record<string, Omit<Note, "code">> = {
  "cuts-line-at-start": {
    label: "Cuts a line at the start",
    detail: "The clip begins partway through a spoken line. Check the opening cut.",
    severity: "important",
  },
  "cuts-line-at-end": {
    label: "Cuts a line at the end",
    detail: "The clip stops partway through a spoken line. Check the final cut.",
    severity: "important",
  },
  "grazes-line-at-start": {
    label: "Clips the start of a line",
    detail: "A small part of a spoken line falls before the clip starts.",
    severity: "minor",
  },
  "grazes-line-at-end": {
    label: "Clips the end of a line",
    detail: "A small part of a spoken line runs past the end of the clip.",
    severity: "minor",
  },
  "starts-mid-dialogue": {
    label: "Starts during a line",
    detail: "Someone is already speaking when the clip begins.",
    severity: "minor",
  },
  "ends-mid-dialogue": {
    label: "Ends during a line",
    detail: "Someone is still speaking when the clip ends.",
    severity: "minor",
  },
  "quiet-opening": {
    label: "Quiet opening",
    detail: "Only camera directions happen in the first three seconds.",
    severity: "important",
  },
  "quiet-ending": {
    label: "Quiet ending",
    detail: "Only camera directions happen in the final three seconds.",
    severity: "minor",
  },
  "no-dialogue-or-action": {
    label: "No dialogue or action",
    detail: "The clip has only camera directions or sounds.",
    severity: "important",
  },
  "near-duplicate": {
    label: "Very close to another clip",
    detail: "Most of this clip overlaps another candidate.",
    severity: "minor",
  },
  "hook-needs-prior-context": {
    label: "Hook needs earlier story",
    detail: "The opening mostly works for someone who already knows the show.",
    severity: "important",
  },
  "essential-context-missing": {
    label: "Missing key context",
    detail: "A new viewer would lack something important to follow this clip.",
    severity: "important",
  },
  "needs-earlier-context": {
    label: "Leans on earlier episodes",
    detail: "Parts of this clip assume the viewer has seen more of the story.",
    severity: "minor",
  },
  "unclear-characters": {
    label: "Unclear characters",
    detail: "It may be hard to tell who these people are.",
    severity: "minor",
  },
  spoiler: {
    label: "Possible spoiler",
    detail: "This clip may give away a later story turn.",
    severity: "content",
  },
  violence: {
    label: "Violence",
    detail: "Check platform rules before posting.",
    severity: "content",
  },
  intimacy: {
    label: "Intimacy",
    detail: "Check platform rules before posting.",
    severity: "content",
  },
  "model-quote-not-in-clip": {
    label: "Quote not found in the clip",
    detail: "The AI explanation quotes words this clip does not contain. Trust the script.",
    severity: "important",
  },
  "cold-viewer-claims-without-evidence": {
    label: "Some claims lack evidence",
    detail: "Part of the new-viewer check did not point at anything in the clip.",
    severity: "important",
  },
  "model-cited-unknown-events": {
    label: "Unknown lines cited",
    detail: "The AI cited lines that do not exist. Those citations were ignored.",
    severity: "minor",
  },
  "model-cited-events-outside-window": {
    label: "Some citations ignored",
    detail: "The AI cited moments outside the opening or ending. Those were ignored.",
    severity: "minor",
  },
};

const REVIEW: Record<string, Omit<Note, "code" | "severity">> = {
  "hook-at-the-minimum": {
    label: "Weak hook",
    detail: "The opening only just met the minimum for a usable promo.",
  },
  "cliffhanger-at-the-minimum": {
    label: "Weak ending",
    detail: "The ending only just met the minimum for a usable promo.",
  },
  "clarity-at-the-minimum": {
    label: "Check clarity",
    detail:
      "A new viewer gets the basic situation but may miss who is involved or what is at risk.",
  },
};

const LOWERED: Record<string, string> = {
  "no-hook-evidence-in-opening": "Nothing it cited falls in the first three seconds.",
  "hook-needs-prior-context": "The opening mostly works for someone who knows the story.",
  "no-cliffhanger-evidence-in-ending": "Nothing it cited falls in the final three seconds.",
  "nothing-left-unresolved": "Nothing is left unresolved at the end.",
  "no-emotion-evidence": "No moment in the clip was cited to support it.",
  "cuts-spoken-line": "The clip cuts a substantial part of a spoken line.",
  "what-is-happening-unclear": "A new viewer could not tell what is happening.",
  "stakes-unclear": "A new viewer could not tell what is at stake.",
  "who-is-involved-unclear": "A new viewer could not tell who is involved.",
  "essential-context-missing": "A new viewer would be missing something essential.",
  "mostly-partial-understanding":
    "A new viewer only partly understands who is involved and what is at stake.",
  "would-not-care": "A new viewer would not understand enough to care.",
};

function readable(code: string): string {
  const text = code.replace(/[-:]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function describeWarning(code: string): Note {
  if (code.startsWith("possible-false-cliffhanger:")) {
    const reason = code.split(":")[1] ?? "";
    return {
      code,
      label: "Ending may not hold",
      detail: FALSE_CLIFFHANGER[reason] ?? "The ending may not leave a real question open.",
      severity: "important",
    };
  }
  const known = WARNINGS[code];
  return known
    ? { code, ...known }
    : { code, label: readable(code), detail: "Check this before posting.", severity: "minor" };
}

export function describeReview(code: string): Note {
  if (code.startsWith("comparison-refused")) {
    return {
      code,
      label: "Comparison missing",
      detail: "The AI provider declined a head-to-head comparison, so its rank has less support.",
      severity: "important",
    };
  }
  const known = REVIEW[code];
  return known
    ? { code, ...known, severity: "important" }
    : { code, label: readable(code), detail: "Check this before posting.", severity: "important" };
}

export function describeLowered(code: string): string {
  if (code.startsWith("false-cliffhanger:")) {
    return FALSE_CLIFFHANGER[code.split(":")[1] ?? ""] ?? "The ending may not hold.";
  }
  return LOWERED[code] ?? readable(code);
}

const METHODS: Record<string, string> = {
  "ai-writer-context": "AI reading with the writers' notes",
  "ai-screen-only": "AI reading only what is on screen",
  cues: "Script cues such as questions and scene endings",
  uniform: "Even sampling across the episode",
  "editorial-correction": "An adjusted start or end suggested during evaluation",
};

export function describeMethod(method: string): string {
  return METHODS[method] ?? readable(method);
}

const TENSION: Record<string, string> = {
  "unanswered-question": "An unanswered question",
  "interrupted-reveal": "An interrupted reveal",
  "pending-decision": "A decision still to be made",
  "escalating-confrontation": "A confrontation still growing",
  "impending-consequence": "A consequence about to land",
  none: "Nothing clear",
};

export function describeTension(tension: string): string {
  return TENSION[tension] ?? readable(tension);
}

export const TIER_LABEL = {
  excellent: "Excellent",
  strong: "Strong",
  usable: "Usable",
  "below-gate": "Below minimum",
} as const;

export const CERTAINTY_LABEL = {
  clear: "Clear",
  partial: "Partly clear",
  unclear: "Unclear",
} as const;
