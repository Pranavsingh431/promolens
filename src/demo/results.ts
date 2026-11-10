import { toSegments } from "@/domain/evaluation/structural-checks";
import { clipKey, type Candidate, type Interval } from "@/domain/evaluation/candidate";
import { RUBRIC_VERSION } from "@/domain/evaluation/rubric";
import {
  emptyAssessment,
  scoreAssessment,
  type Assessment,
  type ListStatus,
} from "@/domain/ranking/assemble";
import { DEFAULT_RANKING_CONFIG } from "@/domain/ranking/config";
import {
  PROMO_EXPORT_FORMAT,
  RANKING_OUTPUT_FORMAT,
  buildRecommendation,
  listEntry,
  promoExportSchema,
  rankingOutputSchema,
  type Recommendation,
} from "@/domain/ranking/output";
import type { ColdViewerResponse } from "@/domain/ranking/prompts/cold-viewer-v1";
import type { EditorialResponse } from "@/domain/ranking/prompts/editorial-v1";
import { screenDeterministic } from "@/domain/ranking/screening";
import type { ClipEvent } from "@/domain/ranking/windows";
import { createTimeline } from "@/domain/screenplay/timeline";

import type { AnalysisResults } from "@/client/service";

import type { DemoScenario } from "./scenarios";
import { DEMO_SHOW } from "./show";

/**
 * Made-up results built by the real rank-3 code. The model answers are written
 * by hand, but caps, warnings, evidence, timecodes, and validation all come
 * from the same functions the engine uses, so the demo cannot drift from the
 * contract. No model ever saw this data.
 */

const timeline = createTimeline(DEMO_SHOW);
const config = DEFAULT_RANKING_CONFIG;

type Certainty = "clear" | "partial";

type Spec = {
  intervals: Interval[];
  methods: string[];
  ratings: {
    hook: number;
    cliffhanger: number;
    clarity: number;
    emotion: number;
    boundaries: number;
  };
  opening: string;
  question: string;
  ending: string;
  tension: EditorialResponse["cliffhanger"]["tension"];
  continueBecause: string;
  why: string;
  who: string;
  what: string;
  stakes: string;
  open: string;
  certainty?: { who: Certainty; stakes: Certainty };
  missing?: Array<{ item: string; essential: boolean }>;
  warnings?: EditorialResponse["warnings"];
};

const story = (events: readonly ClipEvent[]) => events.filter((e) => e.kind !== "camera");

function candidateFor(spec: Pick<Spec, "intervals" | "methods">): Candidate {
  const segments = toSegments(timeline, spec.intervals);
  const key = clipKey(segments);
  return {
    id: `hybrid:${key}`,
    clipKey: key,
    method: "hybrid",
    methodVersion: "demo",
    rank: 1,
    score: null,
    segments,
    durationMs: segments.reduce((sum, s) => sum + s.endMs - s.startMs, 0),
    adjustments: [],
    cues: spec.methods.map((method) => `src:${method}`),
  };
}

function screened(candidate: Candidate) {
  const [stageA] = screenDeterministic([candidate], timeline, config);
  if (!stageA?.pass) throw new Error(`Demo clip ${candidate.id} is not a valid clip`);
  return stageA;
}

function assess(spec: Spec): Assessment {
  const candidate = candidateFor(spec);
  const stageA = screened(candidate);
  const { view } = stageA;
  const cite = view.events.slice(0, 2).map((e) => e.ref);
  const answer = (text: string, certainty: Certainty = "clear") => ({
    text,
    certainty,
    evidence: cite,
  });
  const cold: ColdViewerResponse = {
    involved: answer(spec.who, spec.certainty?.who),
    happening: answer(spec.what),
    stakes: answer(spec.stakes, spec.certainty?.stakes),
    openQuestion: answer(spec.open),
    missingContext: spec.missing ?? [],
    wouldCare: { verdict: "yes", reason: "There is a clear threat." },
    guesses: [],
    clarity: spec.ratings.clarity,
  };
  const editorial: EditorialResponse = {
    hook: {
      rating: spec.ratings.hook,
      opening: spec.opening,
      evidence: story(view.opening)
        .slice(0, 2)
        .map((e) => e.ref),
      surprise: "dialogue",
      question: spec.question,
      needsPriorContext: false,
    },
    cliffhanger: {
      rating: spec.ratings.cliffhanger,
      ending: spec.ending,
      evidence: story(view.ending)
        .slice(-2)
        .map((e) => e.ref),
      tension: spec.tension,
      falseCliffhanger: "none",
      reasonToContinue: spec.continueBecause,
    },
    emotion: { rating: spec.ratings.emotion, evidence: cite, note: "Fear and suspicion." },
    boundaries: { rating: spec.ratings.boundaries, start: "clean", end: "clean", note: "" },
    hookKind: "danger",
    whyItWorks: spec.why,
    warnings: spec.warnings ?? [],
    correction: { propose: false, startRef: "", endRef: "", reason: "" },
  };
  return scoreAssessment(
    {
      ...emptyAssessment(candidate, stageA),
      screenStatus: "ok",
      priority: 80,
      selection: "priority",
      cold,
      editorial,
      deepStatus: "ok",
    },
    config,
  );
}

const STRONG = assess({
  intervals: [{ episode: 1, startMs: 5_000, endMs: 31_000 }],
  methods: ["ai-writer-context", "cues"],
  ratings: { hook: 4, cliffhanger: 4, clarity: 4, emotion: 3, boundaries: 3 },
  opening:
    'Mara unfolds a soaked page and says, "My name was crossed out before I ever came aboard."',
  question: "Who crossed out her name, and why is she hiding?",
  ending: "A shout from below deck says the cargo is gone, and Oda drags Mara toward the stairs.",
  tension: "impending-consequence",
  continueBecause: "A viewer wants to know what was stolen and what Oda will do with her.",
  why: "A stowaway catches the captain in a lie, and then the ship itself turns on them both.",
  who: "A stowaway named Mara and the ship's captain, Oda.",
  what: "He finds her hiding on deck and she accuses him of knowing she would be there.",
  stakes: "She could be caught, and he could be exposed.",
  open: "What was taken from the hold, and what does Oda do with her now?",
});

const MULTI_SEGMENT = assess({
  intervals: [
    { episode: 1, startMs: 49_500, endMs: 62_400 },
    { episode: 3, startMs: 49_400, endMs: 61_000 },
  ],
  methods: ["ai-screen-only"],
  ratings: { hook: 4, cliffhanger: 3, clarity: 3, emotion: 4, boundaries: 3 },
  opening: 'The Purser smiles and says, "You should have stayed off this boat, Mara."',
  question: "How does he know her name?",
  ending: "An unlit boat comes out of the fog toward the sinking ferry.",
  tension: "unanswered-question",
  continueBecause: "A viewer wants to know who is on the second boat.",
  why: "Two beats from different episodes make one clean threat and one eerie answer.",
  who: "Mara, the Purser who locks her in, and Oda.",
  what: "She is sealed in the hold, then later learns she was invited aboard.",
  stakes: "Her life, and the truth about who brought her here.",
  open: "Who is on the boat with no lights?",
});

const FINALE = assess({
  intervals: [{ episode: 3, startMs: 40_000, endMs: 67_000 }],
  methods: ["ai-writer-context", "ai-screen-only", "uniform"],
  ratings: { hook: 3, cliffhanger: 4, clarity: 3, emotion: 3, boundaries: 3 },
  opening: 'Mara reaches the last lifeboat and asks, "There is one boat left. Why is it locked?"',
  question: "Why would the last lifeboat be locked?",
  ending: 'Mara looks out at the approaching boat and whispers, "Father?"',
  tension: "interrupted-reveal",
  continueBecause: "A viewer wants to see who answers.",
  why: "A sinking ship, a locked lifeboat, and a reveal that lands on one word.",
  who: "Mara and the Purser on the deck of a sinking ship.",
  what: "He controls the last lifeboat, and she learns her father wrote her name on his list.",
  stakes: "Only the people on his list will survive.",
  open: "Is her father on the second boat?",
});

const WEAK_CLARITY = assess({
  intervals: [{ episode: 2, startMs: 6_200, endMs: 34_000 }],
  methods: ["ai-writer-context"],
  ratings: { hook: 3, cliffhanger: 4, clarity: 3, emotion: 3, boundaries: 3 },
  opening: 'Mara sees a photograph and demands, "Where did you get that?"',
  question: "What is in the photograph?",
  ending: 'She reads the list of names and says, "The last one is mine."',
  tension: "impending-consequence",
  continueBecause: "A viewer wants to know who is killing the people on the list.",
  why: "The closing line is chilling, though a new viewer has to work out who these two are.",
  who: "A woman and an older man who knew her father. Their history is only hinted at.",
  what: "He shows her a list of names, ten of them dead, and the last is hers.",
  stakes: "Someone may be coming for her, but why is left unclear.",
  open: "Who is behind the list?",
  certainty: { who: "partial", stakes: "partial" },
  missing: [{ item: "How she and the captain know each other.", essential: false }],
  warnings: ["needs-earlier-context"],
});

const ROUGH_CUTS = assess({
  intervals: [{ episode: 2, startMs: 43_000, endMs: 65_000 }],
  methods: ["cues", "uniform"],
  ratings: { hook: 3, cliffhanger: 3, clarity: 3, emotion: 3, boundaries: 3 },
  opening: "A voice over the loudspeaker tells the whole ship that a stowaway is aboard.",
  question: "Who will help her now?",
  ending: "An old woman lets Mara in, and Mara notices the red paint on her coat.",
  tension: "unanswered-question",
  continueBecause: "A viewer wants to know whose side the old woman is on.",
  why: "The net closes fast, and the one safe door turns out not to be safe.",
  who: "A woman on the run and a stranger who hides her.",
  what: "The ship is told she is dangerous, and a passenger takes her in.",
  stakes: "Everyone aboard has been told to fear her.",
  open: "Can she trust the woman who took her in?",
});

const REPEAT = assess({
  intervals: [{ episode: 1, startMs: 8_400, endMs: 32_000 }],
  methods: ["cues"],
  ratings: { hook: 3, cliffhanger: 3, clarity: 3, emotion: 3, boundaries: 3 },
  opening: "Mara tears out the page as Oda steps onto the deck with his flashlight.",
  question: "What is on the page?",
  ending: "Oda drags Mara toward the stairs after a shout that the cargo is gone.",
  tension: "impending-consequence",
  continueBecause: "A viewer wants to know what was stolen.",
  why: "Same confrontation as the top pick, with a slightly weaker opening.",
  who: "A stowaway and the captain.",
  what: "He finds her and she accuses him of knowing she would be there.",
  stakes: "She could be caught.",
  open: "What was taken from the hold?",
});

const ALTERNATIVE = assess({
  intervals: [{ episode: 3, startMs: 12_400, endMs: 35_400 }],
  methods: ["ai-screen-only", "uniform"],
  ratings: { hook: 2, cliffhanger: 3, clarity: 3, emotion: 2, boundaries: 3 },
  opening: 'Oda asks, "Who had the keys to this deck?"',
  question: "Who sabotaged the engine?",
  ending: 'Oda orders the lifeboats readied, "All but one."',
  tension: "pending-decision",
  continueBecause: "A viewer wants to know who he is leaving behind.",
  why: "A quiet betrayal in the engine room, with a sharp last line.",
  who: "The captain and his engineer.",
  what: "They discover the engine was sabotaged and only the captain had keys.",
  stakes: "The ship has twenty minutes.",
  open: "Who does he plan to leave behind?",
});

const BELOW_GATE = assess({
  intervals: [{ episode: 1, startMs: 32_000, endMs: 54_000 }],
  methods: ["uniform"],
  ratings: { hook: 1, cliffhanger: 1, clarity: 2, emotion: 1, boundaries: 3 },
  opening: "A wide shot of an empty hold.",
  question: "",
  ending: "Mara asks how the Purser knows her name.",
  tension: "unanswered-question",
  continueBecause: "",
  why: "It takes too long to get going.",
  who: "A captain, a stowaway, and a purser.",
  what: "They inspect the empty hold.",
  stakes: "Missing cargo.",
  open: "Who took the crates?",
});

function unjudged(intervals: Interval[], methods: string[], kind: "refused" | "failed") {
  const candidate = candidateFor({ intervals, methods });
  return {
    ...emptyAssessment(candidate, screened(candidate)),
    screenStatus: "ok" as const,
    priority: 75,
    selection: "priority" as const,
    deepStatus: kind,
    deepError: kind === "refused" ? "failed:content-policy" : "failed:malformed-json",
  } satisfies Assessment;
}

const REFUSED = unjudged(
  [{ episode: 3, startMs: 0, endMs: 24_000 }],
  ["ai-writer-context"],
  "refused",
);
const FAILED = unjudged([{ episode: 2, startMs: 38_000, endMs: 60_000 }], ["cues"], "failed");

const NOT_ASSESSED: Assessment = (() => {
  const candidate = candidateFor({
    intervals: [{ episode: 1, startMs: 50_000, endMs: 74_000 }],
    methods: ["uniform"],
  });
  return { ...emptyAssessment(candidate, screened(candidate)), screenStatus: "ok", priority: 40 };
})();

const strength = (a: Assessment, wins: number, losses: number) => ({
  id: a.candidate.id,
  strength: (wins + 1) / (losses + 1),
  wins,
  losses,
  ties: 0,
  comparisons: wins + losses,
});

function buildResults(input: {
  picks: Array<{ assessment: Assessment; wins: number; losses: number; refused?: number }>;
  others: Array<{ assessment: Assessment; alternateOf?: Assessment }>;
  belowGate: Assessment[];
  notAssessed: Assessment[];
  refused: Assessment[];
  failed: Assessment[];
  refusedComparison: { first: Assessment; second: Assessment } | null;
  status: "complete" | "partial";
}): AnalysisResults {
  const ordered: Array<{ assessment: Assessment; status: ListStatus }> = [
    ...input.picks.map(({ assessment }) => ({ assessment, status: "finalist" as const })),
    ...input.others.map(({ assessment }) => ({ assessment, status: "eligible" as const })),
    ...input.belowGate.map((assessment) => ({ assessment, status: "below-gate" as const })),
    ...input.notAssessed.map((assessment) => ({ assessment, status: "not-assessed" as const })),
    ...input.refused.map((assessment) => ({ assessment, status: "provider-refused" as const })),
    ...input.failed.map((assessment) => ({ assessment, status: "assessment-failed" as const })),
  ];
  const position = new Map(ordered.map((entry, i) => [entry.assessment.candidate.id, i + 1]));
  const recommend = (
    assessment: Assessment,
    rank: number,
    wins: number,
    losses: number,
    refused = 0,
  ): Recommendation =>
    buildRecommendation({
      rank,
      assessment,
      listPosition: position.get(assessment.candidate.id) ?? rank,
      scoreRank: rank,
      strength: strength(assessment, wins, losses),
      diversity: { maxSimilarity: 0.1, nearest: null },
      refusedComparisons: refused,
      gateMinimum: config.gateMinimum,
    });

  const shortlist = input.picks.map((p, i) =>
    recommend(p.assessment, i + 1, p.wins, p.losses, p.refused),
  );
  const judged = input.picks.length + input.others.length;
  const ranking = rankingOutputSchema.parse({
    format: RANKING_OUTPUT_FORMAT,
    runId: "demo-night-ferry",
    createdAt: "2026-11-10T09:00:00.000Z",
    packSha256: "0".repeat(64),
    status: input.status,
    scope: { label: "all", episodes: DEMO_SHOW.episodes.map((e) => e.number) },
    versions: {
      ranking: config.version,
      configHash: "demo",
      rubric: RUBRIC_VERSION,
      prompts: {},
      models: { all: "none, made up for this demo" },
    },
    config,
    counts: {
      poolInScope: ordered.length,
      assessed: judged + input.belowGate.length,
      eligible: judged,
      belowGate: input.belowGate.length,
      refusedByProvider: input.refused.length,
      comparisonsRefused: input.refusedComparison ? 1 : 0,
      shortlist: shortlist.length,
    },
    shortlist,
    alternates: input.others
      .filter((o) => o.alternateOf)
      .map((o) => ({
        candidateId: o.assessment.candidate.id,
        listPosition: position.get(o.assessment.candidate.id) ?? 1,
        redundantWith: o.alternateOf?.candidate.id,
        similarity: 0.62,
        basis: "time",
      })),
    list: ordered.map((entry, i) => listEntry(i + 1, entry.status, entry.assessment)),
    incomplete: {
      refusedClips: input.refused.map((a) => ({
        candidateId: a.candidate.id,
        clipKey: a.candidate.clipKey,
        stage: "detailed",
        kind: "content-policy",
      })),
      refusedComparisons: input.refusedComparison
        ? [
            {
              pairId: `${input.refusedComparison.first.candidate.id}|${input.refusedComparison.second.candidate.id}`,
              first: input.refusedComparison.first.candidate.id,
              second: input.refusedComparison.second.candidate.id,
              replicate: 0,
            },
          ]
        : [],
      failedClips: input.failed.map((a) => a.candidate.id),
    },
    positionBias: {
      judgments: 0,
      ties: 0,
      firstShownWinShare: null,
      positionPValue: null,
      repeatedPairs: 0,
      consistent: 0,
      reversed: 0,
      reversedTowardSecond: 0,
      reversedTowardFirst: 0,
    },
    notes: ["This run is made up for the demo. No model was called."],
  });

  const promos = promoExportSchema.parse({
    format: PROMO_EXPORT_FORMAT,
    runId: ranking.runId,
    createdAt: ranking.createdAt,
    packSha256: ranking.packSha256,
    rankingVersion: config.version,
    configHash: "demo",
    status: input.status,
    note: "Made up for the demo. No model was called and no person rated these clips.",
    promos: [
      ...input.picks.map((p, i) => ({
        shortlistRank: i + 1,
        alternateOf: null,
        promo: recommend(p.assessment, i + 1, p.wins, p.losses, p.refused),
      })),
      ...input.others.map((o, i) => ({
        shortlistRank: null,
        alternateOf: o.alternateOf?.candidate.id ?? null,
        promo: recommend(o.assessment, input.picks.length + i + 1, 1, 3),
      })),
    ],
  });
  return { ranking, promos };
}

const PICKS = [
  { assessment: STRONG, wins: 7, losses: 1 },
  { assessment: MULTI_SEGMENT, wins: 6, losses: 2 },
  { assessment: FINALE, wins: 5, losses: 2, refused: 1 },
  { assessment: WEAK_CLARITY, wins: 4, losses: 4 },
  { assessment: ROUGH_CUTS, wins: 3, losses: 4, refused: 1 },
];

export function buildDemoResults(scenario: DemoScenario): AnalysisResults {
  if (scenario === "empty") {
    return buildResults({
      picks: [],
      others: [],
      belowGate: [BELOW_GATE],
      notAssessed: [NOT_ASSESSED],
      refused: [],
      failed: [],
      refusedComparison: null,
      status: "complete",
    });
  }
  return buildResults({
    picks: PICKS,
    others:
      scenario === "partial"
        ? [{ assessment: REPEAT, alternateOf: STRONG }]
        : [{ assessment: REPEAT, alternateOf: STRONG }, { assessment: ALTERNATIVE }],
    belowGate: [BELOW_GATE],
    notAssessed: [NOT_ASSESSED],
    refused: [REFUSED],
    failed: scenario === "partial" ? [FAILED] : [],
    refusedComparison: { first: FINALE, second: ROUGH_CUTS },
    status: scenario === "partial" ? "partial" : "complete",
  });
}
