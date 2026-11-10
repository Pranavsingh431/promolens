# Evaluation methodology

This document explains how PromoLens measures whether it picks good promos,
before any model is involved. The code lives in `src/domain/evaluation/`
(rules and metrics) and `src/server/evaluation/` (files and the review tool).

## What "good" means, and what we can measure

| Level                  | Question                           | How we measure it                                             |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------- |
| Structural correctness | Is the clip legal and cleanly cut? | Deterministic checks. No labels needed.                       |
| Editorial quality      | Would an editor post it?           | Human ratings with the rubric below.                          |
| Audience performance   | Does it bring in viewers?          | Real view and install data. Not available in this assignment. |

We can measure the first two. Rubric scores describe an editor's judgment.
They are not a prediction of views, and nothing here should be read as one.

## Rubric (version 1.0)

The brief names three properties of a good promo. They are the essential
criteria. Two more criteria capture quality that editors care about.

| Criterion               | Essential | 0                                | 2                                   | 4                                  |
| ----------------------- | --------- | -------------------------------- | ----------------------------------- | ---------------------------------- |
| First-three-second hook | Yes       | Nothing happens                  | A clear point of interest           | An arresting moment opens the clip |
| Unresolved ending       | Yes       | Ends resolved or neutral         | Ends on a clear unanswered question | Cuts at the peak                   |
| Makes sense on its own  | Yes       | A new viewer could not follow it | Basic situation is clear            | Completely self-contained          |
| Emotional pull          | No        | Flat                             | Clear emotion                       | Intense throughout                 |
| Clean start and end     | No        | Breaks mid-line or mid-action    | Edges slightly early or late        | Edges feel deliberate              |

Every level from 0 to 4 has a full description in
`src/domain/evaluation/rubric.ts`, and the review tool shows all of them.

**Keep rule.** A reviewer decides keep or reject and picks a main reason. A
clip can be kept only when all three essential criteria are rated 2 or
higher. This is enforced, so a clip a new viewer cannot follow can never be
kept or rated excellent.

**Overall assessment** is derived from the ratings, never entered by hand:

| Overall   | Rule                                                               | Gain for nDCG |
| --------- | ------------------------------------------------------------------ | ------------- |
| reject    | The reviewer rejected it                                           | 0             |
| usable    | Kept; the weakest essential criterion is 2                         | 1             |
| strong    | Kept; every essential criterion is 3 or higher                     | 2             |
| excellent | Strong, at least two essential criteria at 4, and clean edges (3+) | 3             |

## Why human labels are required

The screenplay pack has no promo labels. Valid timestamps say nothing about
whether a clip hooks anyone. A model's own scores cannot grade the model. So
editorial metrics are computed only from human judgments, and they are shown
as "unavailable" until those exist. No model output is ever stored as a human
judgment.

## Evaluation sample

`npm run eval -- sample <pack.zip>` chooses about 12 episodes, deterministically:

1. Each episode is profiled from parsed events only: length, position in the
   series, when dialogue starts, the share of dialogue and of action, how many
   lines end in "!" or "?", reveal phrases, whether the first scene continues
   the previous episode, and boundary difficulty (overlapping or out-of-order
   lines).
2. Episodes are grouped into length thirds and series-position thirds. One
   episode is drawn at random, with a fixed seed, from each of the nine groups.
3. Any missing trait (strong opening, quiet opening, dialogue-heavy,
   action-heavy, high intensity, reveal lines, continuity, difficult
   boundaries) is filled with a random episode that has it. Random episodes
   then fill up to the target.
4. Episodes are paired by length and a seeded coin sends one of each pair to
   the held-out set, so both halves cover the same lengths.

Nothing in the selection looks at how a method performs. The sample, its
reasons, and the split are saved to `private/evaluation/sample.json`. The
command refuses to redraw an existing sample unless you pass `--force`.

**Held-out rules.** Development episodes are for studying failures and
improving methods. Held-out episodes are for final checks only. Metrics
default to the development split; asking for the held-out split prints a
warning and appends a line to `reports/held-out-runs.log`, so every look is
on record. Do not tune rules or weights on held-out results.

## Annotation workflow

Start the local review tool with `npm run eval:review -- <pack.zip>` and open
http://127.0.0.1:4310. Each reviewer uses an anonymous code (for example
`R1`). Work is saved to `private/evaluation/annotations/<code>.json` after
every action, so a review can stop and resume at any time.

**Part A, find moments (source-aware).** The reviewer reads a whole sampled
episode, as on-screen events with scene headings, before seeing any method's
suggestions. They click a start line and an end line, see the length and any
cut line, rate the clip, and save it. When they have marked every moment they
would post, they mark the episode complete. Part A answers "what should a good
method have found?"

**Part B, rate clips (cold viewer).** The reviewer rates candidate clips one
at a time, as someone who has never seen the show. Each clip shows only its
own on-screen events, timed from the clip start. It never shows the episode
number, scene headings, writer notes, other scenes, the method, a score, or
an explanation. Clips from all methods are merged (a clip two methods share is
rated once) and shuffled with a fixed seed. The mapping back to methods is in
`review/key.json`, which the tool never serves.

Do Part A before Part B. Ideally, a reviewer does not rate Part B clips from
episodes they read in Part A, or a second reviewer does Part B.

**Files and versions.** Annotation files are validated with Zod and checked
against the sample, the screenplay, and the review items. Every moment and
rating carries a version that the server raises on each real change, and the
file carries a revision that rejects saves from a stale window. Several
reviewers' judgments of one clip stay in separate files and are never
overwritten.

## Baselines

Any later method has to beat these. Both work only from parsed events, record
every proposal they drop with a reason, and record every boundary move.

- **Uniform (`uniform-1`).** 30-second windows every 15 seconds. Each edge is
  moved to a camera shot change within 2 seconds when that keeps the clip
  legal. Edges that would cut a spoken line are moved to the edge of that line.
  The ranking is a seeded shuffle, because uniform sampling has no opinion.
- **Cues (`cues-1`).** Ends a clip on the episode end (+3), a line ending in
  "?" (+2), a line ending in "!" or trailing off (+1), or a scene end (+1).
  Starts it on a scene start, a line with "!", a line with a conflict phrase,
  or a physical action (+1 each), at the shot change just before that event.
  Each end takes its best start 20 to 60 seconds earlier. The best five per
  episode that overlap each other by less than half are kept.

## AI candidates and the hybrid pool

`npm run discover` writes `ai-writer-context.json`, `ai-screen-only.json`, and
`hybrid.json` next to the baselines. A complete `npm run rank` run adds
`ranked.json`, the Phase 4 order over the whole pool. The commands below pick
them all up like any other candidate set, so they get the same structural
checks, metrics, and blind review. See [AI candidate discovery](discovery.md)
and [Promo evaluation and ranking](ranking.md).

### Review rounds

`prepare-review` takes `--split` to build items for one split only, and
`--controls <n>` to add, per episode, a seeded sample of lower-ranked clips
from the ranking (or the set named by `--control-set`). Controls look like
any other item, so a reviewer cannot infer quality from being shown a clip.
`--shortlist <ranking.json>` adds the final recommendations, and
`--shortlist-controls <n>` adds lower-ranked clips from the same episodes to
compare them with, so a reviewer can rate the list an editor would actually
read. Recommendations from held-out episodes are left out. `--append` keeps
every existing item and id and adds only new clips, so ratings already made
stay valid; this is how held-out items are added after the ranking
configuration is frozen. `eval:review -- pack.zip --split development` shows
that split's episodes in Part A. In Part B it hides clips from the other split
and keeps clips from episodes outside the sample, since those belong to
neither split. The report compares recommendations with those lower-ranked
clips, from human ratings only.

## Structural checks

Every candidate is checked before review. Errors: unknown episode, a segment
outside the episode, a total length outside 20 to 60 seconds, a stated length
that does not match, segments that reuse footage, event references that do not
match the timeline, a segment with no events, an id that does not match its
segments, and an exact duplicate of a higher-ranked candidate. Warnings: an
edge that cuts a spoken line, no dialogue or action at all, and a near
duplicate (IoU 0.8 or more). Info: an edge that cuts a camera shot, and
segments played out of story order.

Fixes are never silent. `proposeBoundaryFix` returns a new candidate with a new
id, `derivedFrom` pointing at the original, and a list of every edge it moved
and why. The original is not changed.

## Metrics

All metrics are computed per episode and then averaged over the episodes where
they exist, so one long episode cannot dominate. Each average reports how many
episodes it used. Ties in ranking break by score, then episode, then start
time, then clip key.

A pick is **judged** when a human rated exactly that clip in Part B, or when
it matches a Part A moment with temporal IoU of 0.5 or more. Otherwise it is
**unjudged**: it is skipped, never counted as bad. A pick that overlaps a
higher-ranked pick by IoU 0.5 or more is **redundant** and earns nothing,
because a second copy of a moment adds nothing for an editor. It counts as
judged only if the pick it repeats was judged. When several reviewers rated
one Part B clip, it is relevant on a strict majority of keeps, and its gain is
the lower median.

| Metric           | Definition                                                                                                                                                                         | Unavailable when                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Judged@K         | Judged picks among the method's real top K, divided by K (or by the number of picks if fewer)                                                                                      | The method has no picks                           |
| Precision@K      | Kept picks among the first K judged picks, divided by the number of those judged picks (at most K)                                                                                 | No pick is judged                                 |
| nDCG@K           | DCG of the first K judged picks (gain / log2(rank + 1)) divided by the best possible DCG from every judged clip in the episode, with near duplicates merged                        | No positive clip is known for the episode         |
| Recall@K         | Kept Part A moments matched by the top K picks, divided by all kept Part A moments, per reviewer, then averaged                                                                    | No reviewer marked the episode complete in Part A |
| Boundary error   | Absolute start and end difference to the matched Part A moment, as median and mean                                                                                                 | No pick matches a Part A moment                   |
| Validity rate    | Candidates without structural errors, divided by all candidates                                                                                                                    | Never                                             |
| Episode coverage | Episodes with at least one valid candidate, divided by episodes evaluated                                                                                                          | Never                                             |
| Duplicate rate   | Candidates flagged as exact or near duplicates, divided by all candidates                                                                                                          | Never                                             |
| Agreement        | Per pair of reviewers on shared Part B clips: keep/reject agreement and Cohen's kappa, and per criterion exact agreement, agreement within one point, and quadratic weighted kappa | Fewer than two shared clips                       |

Recall needs a complete Part A review because recall against partial labels
would pretend every relevant moment was found. Even then it is recall against
one reviewer's moments, not against every possible promo.

**Show-level list metrics.** An editor reads one shortlist for the whole show,
so the report also reads each method's full ranking over the split as one list
and reports Judged@10, unjudged picks in the top 10, and judged-only
Precision@10 and nDCG@10 (`--list-k` changes 10). The same rules apply:
unjudged picks are skipped, not counted as bad, and repeats earn nothing.
Judged-only precision is not ordinary full-list precision: when Judged@10 is
low, it describes only the few picks someone rated. Recall is reported per
episode only.

## Preventing leakage

- Writer notes (loglines, continuity notes) are kept apart from on-screen
  events in the canonical model, and no review view includes them.
- Part B shows only the clip's events and hides episode, position, method, and
  score. Clip keys never reach the browser.
- Review order is a seeded shuffle; methods are mixed together.
- The review tool listens on 127.0.0.1 only and rejects requests for any other
  host name.
- Held-out episodes are reported separately, and every held-out run is logged.

## Commands

```bash
npm run eval -- sample pack.zip           # once per evaluation
npm run eval -- candidates pack.zip       # baselines for every episode
npm run eval -- prepare-review pack.zip   # blind Part B items (see Review rounds)
npm run eval:review -- pack.zip           # human review tool
npm run eval -- validate pack.zip         # check annotation files
npm run eval -- metrics pack.zip          # JSON metrics, development split
npm run eval -- report pack.zip           # Markdown comparison
```

Everything is written under `private/evaluation/`, which git and Vercel
ignore. Use `--dir` for another location and `--split held-out` or `all` for
other splits. Nothing here needs a model key, a database, or a network.

## Known limitations

- No human annotations exist yet, so every editorial metric is unavailable.
- Model judgments (Phase 4) are never used as labels. Their self-agreement
  and cross-model agreement are reported as consistency, not accuracy.
- Twelve episodes from one show is a small sample. Results will not
  generalize to other genres without more shows.
- The rubric is a practical editorial tool. It has not been validated against
  real audience performance.
- One reviewer's Part A moments are not the full set of good promos, so recall
  is a lower-bound style measure.
- Matching by IoU 0.5 treats two clips as the same moment even when their edges
  differ by several seconds. Boundary error reports that difference separately.
- The cue baseline uses English punctuation and a short English phrase list.
- The review tool is tested through its API; its browser interface was checked
  by hand, not by automated browser tests.
