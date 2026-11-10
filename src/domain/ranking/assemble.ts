import type { Candidate } from "../evaluation/candidate.ts";
import type { Ratings } from "../evaluation/rubric.ts";
import type { Timeline } from "../screenplay/timeline.ts";
import type { RankingConfig } from "./config.ts";
import { similarity, type DiversityItem } from "./diversity.ts";
import type { NarrativeDocument, NarrativeVectors } from "./narrative.ts";
import type { ColdViewerResponse } from "./prompts/cold-viewer-v1.ts";
import type { EditorialResponse } from "./prompts/editorial-v1.ts";
import type { ScreenResponse } from "./prompts/screen-v1.ts";
import {
  applyEditorialRules,
  deriveClarity,
  scoreRatings,
  type ClarityResult,
  type EditorialResult,
  type Scored,
} from "./scoring.ts";
import type { SelectionReason, StageA } from "./screening.ts";

/**
 * Everything known about one candidate as it moves through the stages, and
 * the deterministic steps that turn judgments into an order.
 */

export type DeepStatus = "ok" | "failed" | "not-selected" | "skipped" | "refused";

export type Assessment = {
  candidate: Candidate;
  stageA: StageA;
  screen: ScreenResponse | null;
  screenStatus: "ok" | "failed" | "skipped" | "not-run";
  /** Why the quick read is missing, for example "screen-content-policy". */
  screenError: string | null;
  priority: number | null;
  /** Why it was sent to detailed assessment, or null if screening left it out. */
  selection: SelectionReason | "correction" | null;
  cold: ColdViewerResponse | null;
  editorial: EditorialResponse | null;
  deepStatus: DeepStatus;
  deepError: string | null;
  clarity: ClarityResult | null;
  editorialResult: EditorialResult | null;
  scored: Scored | null;
  /** Set on a clip that is a checked correction of another clip. */
  derived: { from: string; startRef: string | null; endRef: string | null; reason: string } | null;
  /** What happened to this clip's own correction proposal. */
  correction: {
    status: "none" | "valid" | "invalid" | "not-considered";
    reason: string;
    derivedId: string | null;
  };
};

export function emptyAssessment(candidate: Candidate, stageA: StageA): Assessment {
  return {
    candidate,
    stageA,
    screen: null,
    screenStatus: "not-run",
    screenError: null,
    priority: null,
    selection: null,
    cold: null,
    editorial: null,
    deepStatus: "not-selected",
    deepError: null,
    clarity: null,
    editorialResult: null,
    scored: null,
    derived: null,
    correction: { status: "none", reason: "", derivedId: null },
  };
}

/** Applies the evidence checks and caps, then the weighted score and the gate. */
export function scoreAssessment(
  assessment: Assessment,
  config: Pick<RankingConfig, "weights" | "gateMinimum">,
): Assessment {
  if (!assessment.cold || !assessment.editorial) return assessment;
  const view = assessment.stageA.view;
  const clarity = deriveClarity(assessment.cold, view);
  const editorialResult = applyEditorialRules(assessment.editorial, view, assessment.stageA.cuts);
  const ratings: Ratings = {
    hook: editorialResult.hook.rating,
    cliffhanger: editorialResult.cliffhanger.rating,
    clarity: clarity.rating,
    emotion: editorialResult.emotion.rating,
    boundaries: editorialResult.boundaries.rating,
  };
  return { ...assessment, clarity, editorialResult, scored: scoreRatings(ratings, config) };
}

const minEssential = (s: Scored) =>
  Math.min(s.ratings.hook, s.ratings.cliffhanger, s.ratings.clarity);

/** Score, then the weakest essential rating, then clip key. */
export function compareScored(a: Assessment, b: Assessment): number {
  const sa = a.scored;
  const sb = b.scored;
  if (!sa || !sb) return sa ? -1 : sb ? 1 : 0;
  return (
    sb.score - sa.score ||
    minEssential(sb) - minEssential(sa) ||
    (a.candidate.clipKey < b.candidate.clipKey
      ? -1
      : a.candidate.clipKey > b.candidate.clipKey
        ? 1
        : 0)
  );
}

/** Text for comparing story beats: what happens on screen, and the model's description of it. */
export function narrativeDocument(assessment: Assessment, timeline: Timeline): NarrativeDocument {
  const story: string[] = [];
  for (const segment of assessment.candidate.segments) {
    for (const id of segment.eventIds) {
      const event = timeline.event(id);
      if (event && event.kind !== "camera") story.push(event.text);
    }
  }
  const e = assessment.editorial;
  return {
    id: assessment.candidate.id,
    story: story.join(" "),
    description: e
      ? [e.hook.opening, e.cliffhanger.ending, assessment.cold?.happening.text ?? ""].join(" ")
      : "",
  };
}

/** Story events and speakers, for similarity. Camera directions are ignored. */
export function diversityItem(
  assessment: Assessment,
  timeline: Timeline,
  narrative?: NarrativeVectors,
): DiversityItem {
  const storyEvents = new Set<string>();
  const speakers = new Set<string>();
  for (const segment of assessment.candidate.segments) {
    for (const id of segment.eventIds) {
      const event = timeline.event(id);
      if (!event || event.kind === "camera") continue;
      storyEvents.add(id);
      if (event.speaker) speakers.add(event.speaker.toUpperCase());
    }
  }
  return {
    id: assessment.candidate.id,
    segments: assessment.candidate.segments,
    storyEvents,
    speakers,
    hookKind: assessment.editorial?.hookKind ?? null,
    tension: assessment.editorial?.cliffhanger.tension ?? null,
    tier: assessment.scored?.tier ?? "below-gate",
    ...(narrative ? { narrative } : {}),
  };
}

/**
 * The strongest eligible clips, skipping any that repeat a stronger finalist
 * in time or story events. Skipped clips stay in the ranking below the
 * finalists. Pattern similarity does not count here.
 */
export function chooseFinalists(
  eligible: readonly Assessment[],
  timeline: Timeline,
  config: RankingConfig["pairwise"],
): { finalists: Assessment[]; skipped: Array<{ id: string; repeats: string }> } {
  const finalists: Assessment[] = [];
  const items: DiversityItem[] = [];
  const skipped: Array<{ id: string; repeats: string }> = [];
  for (const assessment of eligible) {
    if (finalists.length >= config.finalists) break;
    const item = diversityItem(assessment, timeline);
    const repeat = items.find((other) => {
      const sim = similarity(item, other);
      return sim.basis !== "pattern" && sim.value >= config.distinctSimilarity;
    });
    if (repeat) {
      skipped.push({ id: assessment.candidate.id, repeats: repeat.id });
      continue;
    }
    finalists.push(assessment);
    items.push(item);
  }
  return { finalists, skipped };
}

export type ListStatus =
  | "finalist"
  | "eligible"
  | "below-gate"
  | "not-assessed"
  | "provider-refused"
  | "assessment-failed"
  | "removed";

/**
 * The full order: finalists in pairwise order, other eligible clips by score,
 * clips below the essential gate by score, clips screening left out by
 * screening priority, clips the provider refused to judge, clips whose
 * assessment failed, then clips Stage A removed. A missing judgment never gets
 * a score, so it can never rank above a judged clip. These positions say
 * nothing about quality for an unjudged clip: an editor has to look at it.
 */
export function composeOrder(
  assessments: readonly Assessment[],
  finalistOrder: readonly string[],
): Array<{ assessment: Assessment; status: ListStatus }> {
  const finalists = new Set(finalistOrder);
  const byId = new Map(assessments.map((a) => [a.candidate.id, a]));
  const scored = assessments.filter((a) => a.scored).sort(compareScored);
  const tieKey = (a: Assessment) => a.candidate.clipKey;
  const byPriority = (a: Assessment, b: Assessment) =>
    (b.priority ?? -1) - (a.priority ?? -1) || (tieKey(a) < tieKey(b) ? -1 : 1);

  const list: Array<{ assessment: Assessment; status: ListStatus }> = [];
  for (const id of finalistOrder) {
    const a = byId.get(id);
    if (a) list.push({ assessment: a, status: "finalist" });
  }
  for (const a of scored) {
    if (!finalists.has(a.candidate.id) && a.scored?.gate.pass)
      list.push({ assessment: a, status: "eligible" });
  }
  for (const a of scored) {
    if (!a.scored?.gate.pass) list.push({ assessment: a, status: "below-gate" });
  }
  const passed = assessments.filter((a) => a.stageA.pass && !a.scored);
  for (const a of passed.filter((x) => x.deepStatus === "not-selected").sort(byPriority)) {
    list.push({ assessment: a, status: "not-assessed" });
  }
  for (const a of passed.filter((x) => x.deepStatus === "refused").sort(byPriority)) {
    list.push({ assessment: a, status: "provider-refused" });
  }
  for (const a of passed
    .filter((x) => x.deepStatus !== "not-selected" && x.deepStatus !== "refused")
    .sort(byPriority)) {
    list.push({ assessment: a, status: "assessment-failed" });
  }
  for (const a of assessments
    .filter((x) => !x.stageA.pass)
    .sort((x, y) => (tieKey(x) < tieKey(y) ? -1 : 1))) {
    list.push({ assessment: a, status: "removed" });
  }
  return list;
}
