# Architecture

PromoLens turns a ZIP of timestamped episode screenplays into a ranked list of
promo suggestions. Each suggestion gives the episode and the start and end time
of every segment, the hook, the cliffhanger, and one line on why it works.

The rule behind the design: **code does everything that has a right answer, and
the model does only the judgment calls.** Parsing, timestamps, durations, and
boundary rules are deterministic. Whether a moment hooks a viewer is not.

## Pipeline

| #   | Stage                   | Done by | What it does                                                                                                                                                             | Status |
| --- | ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | Ingest                  | Code    | Read the ZIP. Ignore `__MACOSX/` and dotfiles, reject unsafe paths, cap file count and size.                                                                             | Built  |
| 2   | Parse and normalize     | Code    | Turn each episode file into the screenplay model. Record defects as diagnostics with line numbers.                                                                       | Built  |
| 3   | Find candidates         | Both    | The model marks hook moments and unresolved endings by event number. Code turns them into 20 to 60 s clips on event boundaries and merges them with the baselines.       | Built  |
| 4   | Structural checks       | Code    | Duration, segments inside the episode, no reused footage, no dialogue line cut in half, a hook event inside the first 3 s.                                               | Built  |
| 5   | Narrative evaluation    | Both    | A quick read orders the queue; a detailed call rates hook, cliffhanger, emotion, and boundaries on the rubric, citing events. Code checks the evidence and caps ratings. | Built  |
| 6   | Cold-viewer check       | Both    | A separate call that sees only the promo's on-screen lines and actions. No loglines, no notes, no other clips. Code sets clarity from its answers and their evidence.    | Built  |
| 7   | Rank, dedupe, diversify | Both    | Essential gates, a weighted score, head-to-head comparison of finalists, near-duplicate removal, and a diversity-aware shortlist with a rank reason.                     | Built  |
| 8   | Results and export      | Code    | Validate every promo against the contract, store it, show it in the editor's results view, and export CSV and JSON.                                                      | Built  |
| 9   | Evaluation and usage    | Code    | Rubric, human review tool, baselines, structural checks, ranking metrics, and token use and cost per run.                                                                | Built  |

Stages 1 and 2 are described in [Screenplay ingestion and parsing](screenplay-parsing.md).
Stage 3 is described in [AI candidate discovery](discovery.md). Stages 5 to 8
are described in [Promo evaluation and ranking](ranking.md). The evaluation
part of stage 9 is described in [Evaluation methodology](evaluation.md). The
promo contract exists in `src/domain/promo.ts`.

## What the real input looks like

The supplied pack shaped these decisions. Details stay in a local, git-ignored
note because the pack is confidential.

- One plain-text file per episode, three header lines (episode number,
  logline, continuity notes), then scenes. Each scene has a heading and
  start and end times. Inside a scene, every camera direction, action, sound
  cue, and dialogue line has its own start and end time in `MM:SS.cc`.
- Times restart at zero in each episode, so a promo position is always an
  episode number plus a time.
- Camera directions nearly tile the timeline. They are the natural shot grid
  for cut points.
- Formatting is mostly regular but not perfect: field labels change case,
  scene headings mix dash characters, a few lines are out of order or overlap,
  and one character can appear under several speaker labels. The parser must
  tolerate these and report them.
- Loglines and continuity notes summarize the plot, including spoilers. They
  can guide discovery but must never reach the cold-viewer check.

## Code layout

```
src/
  app/          Pages, layouts, and API route handlers. Thin: validate, call domain, respond.
  components/   UI only. No secrets, no direct model calls.
  client/       Browser logic: the service boundary, job following, result and timeline models, export.
  demo/         Made-up show and results for /demo. Only that route loads it.
  domain/       Pure TypeScript, no I/O.
    screenplay/   Parser, canonical contracts, and timeline index.
    evaluation/   Rubric, candidates, baselines, structural checks, sampling, annotations, metrics.
    discovery/    Discovery prompt, output contract, proposal resolution, and merging.
    ranking/      Clip windows, ranking prompts, scoring and caps, screening, pairwise
                  aggregation, diversity, corrections, and the output contract.
  server/       Server-only code.
    ingest/       Reads ZIP uploads.
    evaluation/   Evaluation files on disk and the local human review tool.
    inference/    Model client, privacy routing, spending and request limits, errors.
    discovery/    Discovery runs, cache, and model defaults.
    ranking/      Ranking runs, judgment cache, experiment budget ledger, and model defaults.
    db/           PostgreSQL schema and connection.
    analysis/     Pipeline steps, orchestration, cache adapters, and analysis identity.
  workflows/    The durable analysis workflow. Steps call `server/analysis`.
scripts/        Command-line tools: validate a ZIP, run evaluation steps, start the review tool, run discovery, rank.
tests/e2e/          Playwright browser tests.
tests/e2e-backend/  The real app and backend in a browser, including a server kill and recovery.
tests/workflow/     The real durable workflow, in-process.
tests/integration/  ZIP ingestion, archive safety, evaluation commands, review tool API, discovery and rank commands, and the API routes.
tests/fixtures/     Synthetic screenplays only.
tests/support/      Test helpers: a synthetic show generator, a mock model API, and a guard that blocks real network calls.
```

Dependency direction: `domain` imports nothing from the other folders.
`server` may import `domain`. `client` may import `domain`. `app` wires
everything together. `components` use `client` and domain types but never call
`server` code directly.

Modules that the command-line tools load use relative imports with a `.ts`
extension, so Node can run them directly without a build step.

## Contracts

- `src/domain/screenplay/schema.ts`: Show, Episode, Scene, Event. Times are
  integer milliseconds with the source token kept beside them. Events are
  stored flat in source order; the timeline index provides time order.
  Speaker labels stay raw. Writer notes are kept apart from on-screen content.
- `src/domain/screenplay/diagnostics.ts`: every ingestion problem with a fixed
  severity (error, warning, info), file, line, and id.
- `src/domain/promo.ts`: Promo with ordered segments, hook, cliffhanger,
  why it works, and rank reason. The schema enforces the hard rules from the
  brief: 20 to 60 seconds in total, segments that end after they start, and no
  footage used twice. Quality rules, such as the hook timing, are checks so a
  weak promo can still be stored and explained.

- `src/domain/evaluation/candidate.ts`: a proposed clip with ordered
  segments, event ids, method, method version, rank, optional score, every
  boundary move, and explainable cue codes. Its identity is its interval set
  (`clipKey`), so evaluation never depends on which method produced it: a
  heuristic, a model, or a human editor.
- `src/domain/evaluation/rubric.ts` and `annotation.ts`: the editorial rubric
  and versioned human annotation files.

- `src/domain/discovery/proposal.ts`: what the discovery model returns, as a
  JSON schema for the provider and a Zod schema for local checks. Proposals
  point at events by number and never carry timestamps.
- Discovery run manifests (written by `scripts/discover.ts`): input hash,
  model, prompt and schema versions, routing, usage, cost, and timings per
  episode.

- `src/domain/ranking/prompts/*.ts`: what each ranking stage returns (quick
  read, cold viewer, editorial judgment, pairwise comparison), each as a JSON
  schema for the provider and a Zod schema for local checks. Evidence is
  cited by clip-local references; source event ids never leave the server.
- `src/domain/ranking/output.ts`: the editor-facing recommendation and the
  full ranking file, validated against the promo contract.

## Web workspace

One screen, driven by one interface. `AnalysisService` in
`src/client/service.ts` covers upload, job status, results, source episodes,
and export. Components call only that interface.

- `/` decides on the server what a visitor may do. A signed-in editor gets
  `HttpAnalysisService`, a visitor gets the sign-in form, and a deployment with
  missing credentials gets `unavailableService`, which fails every call with a
  clear "not connected" state.
- `/demo` uses `src/demo/service.ts`: a scripted job and made-up results, built
  by the real rank-3 scoring and output code so they cannot drift from the
  contract.

**Contracts.** There is no separate format for the browser. Results are
`RankingOutput` (ranking.json) and `PromoExport` (promos.json), checked against
their Zod schemas when they arrive. Source episodes use the screenplay
`Episode` schema, with integer-millisecond times. The job lifecycle is
`analysisJobSchema` in `src/domain/analysis-job.ts`.

**The backend.** [Persistent analysis backend](backend.md) covers routes, jobs,
storage, and sign-in. The browser checks every response against these same
schemas, and it has no route to the demo's data.

**Timeline.** Positions come from the canonical event times, through the same
`clipView` and `lineCuts` code the engine scores with. By default it shows the
clip with 6 seconds either side. The largest real episode has 121 events, so
plain rendering is enough; a cap of 300 protects against an unusually dense
show, and virtualization would add complexity with no benefit.

**Client code size.** The upload screen does not load the schemas, the results
screen, or the demo data. Those load when they are needed.

## Models

- One client (`src/server/inference/openrouter.ts`) that speaks the
  OpenAI-compatible Chat Completions API with strict JSON schemas. OpenRouter
  is the default. The base URL, key, and model come from the environment or
  command options, so another provider can be swapped in without code changes.
- Screenplay requests go only to zero-data-retention endpoints, with data
  collection denied and no tools or web search. If no such endpoint serves a
  model, the run stops rather than loosening the rules. See
  [AI candidate discovery](discovery.md#privacy).
- Every model response is parsed with Zod. An invalid answer is retried a
  limited number of times, then that episode fails with a visible error. No
  silent fallbacks.
- API keys stay on the server. Nothing in `components/` or the browser bundle
  reads them.
- Calls run under a spending cap and a request cap, and validated answers are
  cached by a hash of the input events, the full prompt, the schema, the
  model, and its settings. Ranking also keeps an experiment ledger, so its
  budget holds across runs.
- Each ranking stage has its own model setting. The default judge is from a
  different model family than the discovery model.
- A request the provider refuses is recorded and not sent again unless asked.
  Refused clips and comparisons stay visible as missing, and get no score.

## Storage and background work

The pipeline runs as plain functions from ZIP to results, called by the
command-line tools and by the web app's durable workflow, so both use the same
code. The web app keeps jobs, shows, spending, and validated model answers in
PostgreSQL through Drizzle, keeps uploads, parsed episodes, and results in a
private Blob store, and runs each analysis as a Vercel Workflow so no request
holds it open. The command-line tools need none of that and write to the
git-ignored `private/` folder. See [Persistent analysis backend](backend.md),
[ADR 0001](adr/0001-single-nextjs-app.md), and
[ADR 0002](adr/0002-durable-backend.md).

## Quality checking

The pack has no ground-truth labels for promo quality, so PromoLens will not
report an accuracy number until real editor labels exist. The framework for
getting them is built: a rubric, a sample with a fixed held-out set, a review
tool for source-aware and blind cold-viewer review, two deterministic
baselines, structural checks, and ranking metrics that never count an unrated
clip as bad. See [Evaluation methodology](evaluation.md).

Ranking runs also report label-free signals: how often a judge agrees with
itself on a repeat, how often two model families agree, position bias in
head-to-head comparisons, what screening left out, and which clips the
provider refused. These describe consistency, not quality.

CI never calls a real model. Tests that involve model output use fixed mock
responses.

## Confidentiality

Screenplay packs, extracted scripts, the assignment brief, prompts that contain
source text, and raw model outputs never enter git, `public/`, screenshots, CI
artifacts, or deployments. `.gitignore` and `.vercelignore` enforce the common
paths. Public tests and docs use synthetic screenplays.
