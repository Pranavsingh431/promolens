# Promo evaluation and ranking

Ranking answers one question: which clips would an experienced microdrama
editor post first, and why? It takes the candidate pool from discovery, judges
each clip on the Phase 2 rubric with evidence from the screenplay, compares
the strongest clips head to head, and returns a short, varied list that an
editor can check against exact timestamps.

The editorial score is a ranking aid built from model judgments that code has
checked against the screenplay. It is not a probability of views or virality,
and it is not an audience measurement. No human labels exist yet, so nothing
here proves that the ranking matches an editor's choices. See
[Human review](#human-review-and-accuracy).

Status: built, tested against mocked models, and run on real data. `rank-3` is
the accepted configuration. Recommendations are AI-evaluated and structurally
verified, and have not been independently rated by a person. See
[Results](#results).

## Pipeline

| Stage | Name                  | Done by | What it does                                                                                                     |
| ----- | --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| A     | Deterministic screen  | Code    | Removes clips that cannot be shown: structural errors, exact repeats, nothing on screen at the start or the end. |
| B     | Quick read            | Model   | One cheap call per clip, then a selection for detailed assessment that protects thin episodes and quiet moments. |
| C     | Cold viewer           | Model   | Sees only the clip's own events and answers six questions about who, what, stakes, and what is unresolved.       |
| D     | Editorial scoring     | Model   | Rates hook, cliffhanger, emotion, and boundaries on the rubric, citing the events in each window.                |
| E     | Head to head          | Model   | Compares the strongest distinct clips in pairs and fits one order to the answers.                                |
| F     | Diversity             | Code    | Keeps the shortlist from repeating a moment, in time, in story events, or in what happens.                       |
| G     | Validation and export | Code    | Checks every recommendation against the promo contract and writes JSON and a readable summary.                   |

Stages C and D are independent calls. Code turns their answers into ratings,
applies caps, and computes the score. A failed judgment is recorded as failed
and never replaced by a default score.

## The candidate pool

Phase 3 built a hybrid pool of 252 clips. Checking how it was made showed that
it holds every AI candidate and every cue candidate, merged where two methods
found the same moment, but uniform windows only where they merged with one of
those. None of the 372 uniform windows appears on its own.

Ranking adds back the uniform windows that cover story time no hybrid clip
covers: a window is added when less than half of it lies inside any hybrid
clip (`pool-1`). On the supplied pack that adds 26 windows, for 278 clips in
all. They are a story-blind check on what discovery missed.

## Rubric, weights, and gates

The five criteria and their 0 to 4 levels are the Phase 2 rubric, quoted word
for word in every prompt, so model and human ratings use one scale.

| Criterion               | Weight | Essential | Rated by                         |
| ----------------------- | ------ | --------- | -------------------------------- |
| First-three-second hook | 30%    | Yes       | Editorial stage                  |
| Unresolved ending       | 25%    | Yes       | Editorial stage                  |
| Makes sense on its own  | 20%    | Yes       | Cold-viewer stage                |
| Emotional pull          | 15%    | No        | Editorial stage                  |
| Clean start and end     | 10%    | No        | Editorial stage, with a code cap |

The weights are starting hypotheses. They were not fitted to anything and are
not evidence that these criteria predict views. The score is 25 times the
weighted mean rating, so it runs from 0 to 100.

A weighted average can hide a fatal weakness, so there is a gate: a clip is
eligible for the shortlist only when hook, cliffhanger, and clarity are each
rated 2 or higher. A clip a stranger cannot follow cannot reach the shortlist
on dramatic dialogue alone. Eligible clips also get the human rubric's bands:
usable (weakest essential 2), strong (every essential 3 or more), and
excellent (strong, two essentials at 4, boundaries 3 or more).

### Checks that can only lower a rating

Models cite clip events by reference (C1, C2, ...). Code checks every
reference and records each cap with its reason.

- Hook evidence must be events on screen in the first 3 seconds, or the hook
  is at most 1. A strong moment at second 15 does not rescue a weak opening.
- A hook that only works for someone who knows the story is at most 3.
- Cliffhanger evidence must be events on screen in the final 3 seconds, or
  the cliffhanger is at most 1.
- A false cliffhanger (the question was already answered, the conflict
  resolved, nothing clear is open, it needs knowledge the clip does not give,
  or the cut confuses), or no unresolved tension at all: at most 1.
- Emotion with no cited event in the clip: at most 1.
- An edge that cuts a substantial part of a spoken line (1 s or 30% of it):
  boundaries at most 2. Smaller cuts are warnings only, because overlapping
  lines in the source can make them unavoidable.
- Cold-viewer clarity: see below.

## The first three seconds

The editorial prompt marks every event on screen in the first 3 seconds of the
clip as OPENING, using the clip's actual start. The model describes what a
viewer sees and hears there, cites those events, says whether the surprise is
visual, spoken, both, or neither, names the specific question the opening
raises, and says whether it needs earlier context. Events already under way at
the cut are marked, so a clip that opens mid-line is visible.

The model never suggests captions, music, overlays, or extra footage. If a
clip would hook better from a different start, it may propose a correction
(see [Boundaries](#boundaries-and-corrections)). The original clip keeps its
own rating.

## The ending

The final 3 seconds are marked ENDING. The model describes how the clip ends,
cites those events, names what is left unresolved (an unanswered question, an
interrupted reveal, a pending decision, an escalating confrontation, or a
consequence about to land), and flags a false cliffhanger when there is one.
It is told never to invent what happens next.

## The cold-viewer check

A separate call receives only the events inside the clip, built with
`timeline.eventsForSegments`, which never returns writer notes. It gets no
logline, no continuity notes, no episode number, no scene headings, no event
ids, no other clips, no discovery reasons, and no scores. Each clip is judged
in its own call, so no other clip can fill a gap.

It answers six questions: who is involved, what is happening, what is at
stake, what question is left open, what essential context is missing, and
whether a new viewer would understand enough to care. For the first four it
gives a certainty (clear, partial, unclear) and cites clip events. It is told
that speaker labels show who is talking but do not tell a viewer anyone's
name, and that an honest "unclear" beats a confident guess.

Code then sets clarity, never raising the model's own rating:

- an answer claimed as clear or partial with no cited event in the clip is
  treated as unclear;
- what is happening, or what is at stake, unclear: at most 1;
- who is involved unclear, any essential missing context, two or more of who,
  what, and stakes only partly clear, or a viewer who would not care: at
  most 2.

## Models and privacy

Every stage uses the existing OpenRouter client and the strict
zero-data-retention routing from discovery: only endpoints on OpenRouter's
zero-data-retention list with safety retention off, data collection denied,
every parameter required, structured outputs, and no tools or web search. The
routing check runs again for every model before anything is sent.

| Stage                            | Default model                | Why                                                                                     |
| -------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| Quick read                       | `anthropic/claude-haiku-5.5` | Cheap and fast with no reasoning; only orders the queue.                                |
| Cold viewer, editorial, pairwise | `openai/gpt-6-luna`          | A different model family from discovery, on strict zero-data-retention Azure endpoints. |

Using a different family for judging than for finding is meant to reduce
correlated mistakes: a model may favour the moments it picked itself. That is
an assumption; without human labels we cannot show it helped. On 2026-11-10,
GPT-6 Luna (OpenAI, served by Azure) was on the strict zero-data-retention
list with structured outputs at the same price as Haiku 5.5. Cheaper
open-weight models (DeepSeek, Qwen, Mistral) were listed too; we did not test
them, and a lower price is not evidence of worse or better judgment. Its Azure endpoints
list `max_completion_tokens` rather than `max_tokens`, so the routing plan now
records which name every allowed endpoint accepts and the client sends that
one; `require_parameters` stays on. Every model is a command option, so a
stronger model can be swapped in without code changes.

## Stage B: screening without losing good moments

Detailed assessment costs two calls per clip, so a cheap first read orders the
queue. It sees the same events as the cold viewer and gives quick hook,
cliffhanger, clarity, and emotion ratings and a moment type. Its priority is
the weighted rubric on those ratings with a boundary estimate from cut lines.
Its ratings never enter a final score.

The selection keeps:

1. the top `shortlist` clips by priority (default 80);
2. every episode's best clip, so thin episodes always get a detailed look;
3. the best two clips of every moment type (confrontation, reveal, threat,
   romance, humiliation, emotional, visual or action, quiet tension, other),
   so quiet or visual moments are not screened out by construction;
4. a seeded random sample of 12 of the rest, the exploration sample;
5. any clip whose quick read failed, rather than dropping it.

What screening leaves out is measured, not assumed: the run reports moment
types in and out, the share of clips with obvious keywords ("?" or "!"
endings, conflict words, physical action) in and out, and how the exploration
sample scored when assessed in full.

## Head-to-head comparison

The strongest eligible clips (16 by default) that do not repeat a stronger
finalist in time or story events are compared in pairs. Each is compared with
the next three by score, about 45 comparisons instead of all 120 pairs. The
prompt asks which clip would more effectively make a stranger want to keep
watching, judges each clip only on its own events, allows a tie, and warns
against preferring length, dialogue, violence, important-sounding names, or
intensity without clarity.

Which clip is shown first is decided by a seeded coin per pair, and every pair
is then judged again with the clips swapped (see [Position bias](#position-bias)).
The answers are fitted with a Bradley-Terry model: each order counts as half a
game, so a pair where each order picks the clip in the same position is a tie.
A tie is half a win each, and every clip plays one virtual tied game against a
neutral anchor so strengths stay finite. Equal strengths fall back to the
individual score and then the clip key, so the order never depends on input
order. These are model opinions, not audience measurements.

### Position bias

The judge prefers whichever clip it reads second, and the effect is large
enough to change the order, so it is designed out rather than corrected
afterwards.

| Measure                                                            | Result                             |
| ------------------------------------------------------------------ | ---------------------------------- |
| First-shown clip won, development pilot (58 judgments)             | 40%                                |
| First-shown clip won, full show, mostly one order (59)             | 32%                                |
| First-shown clip won, full show, every pair in both orders (94)    | 31%, exact test p = 0.0003         |
| Odds of the first clip winning, holding clip strength fixed        | about 0.35 to 1 in both early runs |
| Pairs that changed winner when the order was swapped               | 17 of 46 (37%)                     |
| Of those, how many changed toward the clip shown second            | 17 of 17                           |
| The higher-scored clip won when shown second, and when shown first | 83% and 42%                        |

With both orders judged, the bias cancels inside each pair, because a pair
that follows position in both orders counts as a tie. A synthetic test confirms
that a judge with this bias recovers the true order more often when both orders
are used. The cause is not established. Votes per criterion hint at it: the
judge favours the first clip on the hook and the second clip on cliffhanger,
clarity, and emotion, which fits a model that remembers the end of what it just
read. No claim is made that the balanced order is more accurate, only that it
no longer depends on a coin flip.

## Diversity

Two clips are similar by the largest of: time overlap, shared story events,
and pattern (the same hook kind, the same kind of unresolved tension, and
shared speakers). Pattern similarity is capped below the redundancy line, so
two different scenes with the same characters are never treated as the same
moment, only as less novel.

Time and event overlap cannot see a beat retold in another episode: serial
drama carries a scene over an episode break, and two tellings of one moment can
share almost no script text. The shortlist therefore also compares narrative
text, using TF-IDF cosine over each clip's story events and over the model's
short description of what happens. A term found in every clip gets no weight,
so the lead characters' names do not make two clips look alike. Pairs at or
above 0.25 are treated as the same beat, even with no shared footage. On
non-held-out clips of the supplied show, five pairs scored 0.285 or more, each
the same incident or scene, and nothing else scored above 0.232. The value comes
from one show, so it is a working value until reviewers have rated repeats.
Only the shortlist uses this. Head-to-head comparison and every clip's own
score ignore it, and a clip set aside stays visible as an alternate.

The shortlist walks the final order. A clip at least 50% similar to a picked
clip in time or events, or at or above 0.25 in narrative text, becomes an
alternate of it. Otherwise, among the next four clips, the
pick maximizes 0.8 x rank utility minus 0.2 x similarity to earlier picks.
Rank utility falls over the first 30 places, so a clip can move up only a few
places for novelty, never past a better-ranked clip of a higher band. There
are no episode quotas. The default list has 10 promos; alternates are kept.

## Boundaries and corrections

Edges are checked in code: a spoken line cut at either edge, how much of it
is cut, quiet openings or endings, and cuts inside camera shots. Phase 3 left
three AI clips with an edge inside overlapping spoken lines; ranking keeps
them, flags them, and caps boundaries only when the cut is substantial.

The editorial stage may propose a new start or end by citing an event, inside
the clip or just outside it. Code checks the proposal: the reference must
exist, the clip must stay 20 to 60 seconds, and the new clip must pass every
structural check. A valid correction becomes a new clip with its own id, its
own cache key, and a record of where it came from. It is judged again from
scratch on its own opening and ending, and competes in the ranking as itself.
The original keeps its own scores; nothing is ranked on scores from a
different interval. Corrections are considered for the top 30 clips, at most
12 per run.

## Multi-segment promos

The contracts, windows, cold-viewer view, and output all handle several
ordered segments, and tests cover them. No stage generates multi-segment
promos yet. Joining moments only makes sense when the result still tells one
coherent story, and building and checking that reliably did not fit this phase
without risking the single-clip ranking. Every recommendation today is one
continuous clip.

## Output

Each run writes, under the git-ignored `private/ranking/runs/<run>/`:

| File             | Contents                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ranking.json`   | Shortlist, alternates, the full ordered list with each clip's status, what is incomplete, counts, versions, config. |
| `promos.json`    | Every clip that passed the gates, in ranked order, with full segments, hook, cliffhanger, evidence, and warnings.   |
| `promos.csv`     | The same promos, one per row, for a spreadsheet. Cells that a spreadsheet would run as formulas are neutralized.    |
| `shortlist.md`   | A readable review summary. Private: it quotes model descriptions of the story.                                      |
| `judgments.json` | Every raw judgment, repeat, second-judge answer, comparison, and correction.                                        |
| `manifest.json`  | Models, routing, requests, tokens, cost, retries and their causes, cache hits, latency, runtime.                    |

Each recommendation has its rank, editorial score and band, ordered segments
with exact timestamps, total duration, the hook and cliffhanger with their
source events (event ids, on-screen times, and text), one line on why it
works, the cold viewer's answers, every criterion with its caps, warnings,
ranking metadata (head-to-head record, individual score order, nearest
similar pick), and provenance (discovery methods and any correction). Each is
validated against the existing promo contract: 20 to 60 seconds, no reused
footage, hook evidence in the first 3 seconds, ending evidence in the final 3.

Quoted lines in model text are compared with the clip's own events, and a
quote the clip does not contain raises a `model-quote-not-in-clip` warning.
`editorReview` lists what an editor should check before posting: an essential
rating at the minimum (usually clarity 2, where the basic situation is clear
and little else), or a head-to-head comparison the provider refused. Ratings
are never changed here.

A complete run also writes `private/evaluation/candidates/ranked.json`, the
whole order as an ordinary candidate set, so the evaluation commands compare
it with every other method. A partial run does not.

## When a judgment is missing

Every clip in `ranking.json` says whether it was judged:

| `evaluation`       | Meaning                                                                                      | `manualReview` |
| ------------------ | -------------------------------------------------------------------------------------------- | -------------- |
| `complete`         | Cold viewer and editorial answers exist and were checked.                                    | No             |
| `not-run`          | Screening left it out. It has no score, and it was not rejected on the merits.               | No             |
| `provider-refused` | The provider's filter or the model declined. A provider's decision, not an editorial rating. | Yes            |
| `failed`           | A judgment failed for another reason, and a re-run can fill it.                              | Yes            |

A clip without a complete judgment has no score, sits below every judged clip,
and never reaches the shortlist. That position is a policy for keeping unjudged
clips apart from judged ones. It says nothing about quality. A refused or
failed clip has no substitute model and no default rating.

`incomplete` in `ranking.json` lists every refused clip and comparison, and
`shortlist.md` has a "Needs a manual look" section. A refused comparison leaves
the pair with half a game from the order that did get judged, and the affected
recommendations carry `comparison-refused`. A refusal is recorded next to the
judgment cache, so it is not sent again on every re-run; `--retry-refused`
sends it again on purpose. A provider's content filter may catch some of the
most intense moments, so these clips deserve a direct look.

## Cost, cache, and reliability

- **Experiment budget.** A ledger in `private/ranking/ledger.json` adds up
  spending across every ranking run, against a cap of $2 by default. While a
  run is going, its entry counts spent plus reserved money; when it ends, the
  entry becomes what was actually billed. A crash leaves the upper bound.
- **Per-call limits.** Each attempt reserves its worst case first (prompt
  tokens at 1.5 characters per token including the JSON schema, plus the
  full output limit) and is refused if it could break the budget.
- **Cache.** Validated judgments are cached by stage, exact clip boundaries
  and events (or both clips of a pair, in the order shown), the full prompt,
  the JSON schema, prompt and rubric versions, model, token limit, reasoning
  effort, privacy mode, and repeat number. Scores are never cached: they are
  recomputed from judgments with the current configuration on every run, so a
  changed weight or threshold can never reuse an old score, and a changed
  boundary always means a new judgment.
- **Recovery.** Re-running the same command sends only what is missing. A run
  with any missing judgment is marked partial, ranks unjudged clips below
  every judged one, and does not update the evaluation set.
- **Retries.** Every failed attempt is counted by kind and by message. Messages
  name at most a field and a check, never text.
- **Fatal errors** (bad key, no credit, invalid request, no eligible endpoint)
  stop the run.

## Human review and accuracy

No real reviewer labels exist yet, so precision, nDCG, and recall are
unavailable for every method, and this document makes no accuracy claim.

The blind review workflow from Phase 2 now supports a development-only round
that also rates the final shortlist:

```bash
npm run eval -- prepare-review pack.zip --split development --per-method 2 --controls 2 \
  --shortlist private/ranking/runs/<run>/ranking.json --shortlist-controls 1
npm run eval:review -- pack.zip --split development
```

This builds items from every candidate set in the workspace (uniform, cues,
both AI variants, the hybrid pool, and the ranking), plus two lower-ranked
clips per episode from the ranking as controls. `--shortlist` adds the final
recommendations and, for each, a lower-ranked clip from the same episode: the
recommendations often come from outside the sampled episodes, so this is the
only direct check on the list an editor would read. Recommendations from
held-out episodes are left out. Reviewers see no method, rank, or score, and
nothing tells them which clips are controls. Part A asks them to find their
own moments in the full episode first. After the ranking configuration is
frozen, held-out items can be added without disturbing existing ratings:

```bash
npm run eval -- prepare-review pack.zip --split held-out --per-method 2 --controls 2 --append
```

`npm run eval -- report pack.zip --split development` then compares every
method, per episode (K = 3) and as one show-level list (K = 10). List metrics
are judged-only: unrated picks are skipped, never counted as bad, and Judged@K
says how much of the real top K was rated.

## Usage

```bash
npm run rank -- pack.zip --all --dry-run
npm run rank -- pack.zip --episodes 2
npm run rank -- pack.zip --split development --replicates 2 --second-judge anthropic/claude-haiku-5.5
npm run rank -- pack.zip --all
```

`--episodes` refuses held-out episodes; they are ranked only within `--all`.
Other options: `--evaluator`, `--screener`, `--shortlist`, `--explore`,
`--finalists`, `--top`, `--budget`, `--experiment-budget`, `--max-requests`,
`--concurrency`, `--timeout`, `--attempts`, `--retry-refused`. The command prints counts, ids,
and scores only, never screenplay text or model output. Exit code 0 means
complete, 1 partial, 2 a usage or setup error.

## Results

From the supplied 50-episode pack, ranking `rank-3` (`pool-1`, prompts v1,
rubric 1.0). Every figure below is a model judgment or a count. No human has
rated any of these clips, so none of it is evidence of editorial quality or
audience response. Story details stay in private reports.

| Stage                                | Count    |
| ------------------------------------ | -------- |
| Candidates, all passing Stage A      | 278      |
| Left out by screening                | 167      |
| Assessed in detail, with corrections | 118      |
| Passed the essential gates           | 95       |
| Below the gates                      | 23       |
| Episodes with a promo                | 44 of 50 |
| Finalists compared head to head      | 16       |
| Comparisons judged, of 96 scheduled  | 94       |
| Clips refused by the provider        | 1        |
| Comparisons refused by the provider  | 2        |
| Recommendations on the shortlist     | 10       |
| Clips set aside as repeats           | 10       |

Ranking cost $0.4332 in all, across the pilots, the first full run (`rank-2`),
and `rank-3`, of a $2.00 experiment budget. `rank-3` itself added $0.0413,
including a screening check that also assessed 36 more clips. A re-run from
the cache sends nothing and reproduced the output byte for byte, apart from the
run id and the time.

**What the runs showed.**

- **Screening.** The quick read overstates the cliffhanger by 0.5 points on
  average, and all 10 priority picks that failed the gates failed on the
  cliffhanger. To check for lost clips, 42 randomly chosen clips that screening
  had left out were assessed in full (held-out clips excluded from this count).
  27 passed the gates, and the best scored 76.25 against a finalist floor of
  77.5. None reached finalist level, so screening is unlikely to be hiding many
  finalists, but this sample cannot rule it out (at most about 7% at 95%
  confidence).
- **Corrections.** Of 41 proposed, 8 were considered and valid and 33 ranked too
  low to consider. Seven were judged again from scratch: 3 scored higher, 3
  lower, 1 the same, and 3 lost cliffhanger rating. With no measured benefit,
  a correction stays a separate clip that has to earn its place.
- **Standalone clarity.** Three of the ten recommendations sit at clarity 2,
  where the code lowered a 3 because who and what is at stake are only partly
  clear to a cold viewer. They are kept under the rubric and flagged for an
  editor to check.
- **Stability.** Resampling the comparisons, the top clip stays first in about
  half of draws and the rest of the order correlates with the observed one at
  a median Kendall tau of 0.77. Finalists around places 8 to 12 are not reliably
  separated, so treat their order as close to a tie.

## Tests

Unit tests cover window extraction (including multi-segment clips), prompt
isolation and writer-note leakage, delimiter injection, response schemas,
reference parsing, every cap, the weighted score and gates, screening and its
floors, the comparison schedule, Bradley-Terry aggregation, position bias
(including a simulated judge that prefers the second clip), tie-breaking,
narrative similarity, diversity across episodes, corrections, the output
contract and CSV export, list metrics, and review rounds with controls and
shortlists. A mocked end-to-end run covers caching, cache
invalidation on boundary, model, and configuration changes, reproducibility,
failures, recorded refusals, recovery, the budget, fatal errors, and
corrections being judged again. An integration test runs the command against a local mock of
OpenRouter. No test can reach a real model.
