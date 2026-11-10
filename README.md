<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/promolens-logo-dark.svg">
    <img src="public/brand/promolens-logo.svg" alt="PromoLens" width="320">
  </picture>
</p>

<p align="center">Find promo-ready moments in microdrama screenplays.</p>

---

PromoLens reads the timestamped screenplays of a short-form drama series and
suggests promos: 20 to 60-second clips that an editor can post on Instagram,
TikTok, or YouTube to bring in new viewers. For every suggestion it gives the
episode and the exact start and end time of each segment, the hook, the
cliffhanger, and one line on why it works. An editor reviews the ranked list
and makes the final call.

PromoLens finds moments and boundaries. It does not edit video or add music,
captions, or overlays.

## The problem

Microdrama studios release new shows every week. Today an editor watches every
episode and picks promo moments by hand. A good promo:

1. **Hooks in the first three seconds.** A slap, a reveal, or a line that stops
   a scrolling viewer.
2. **Ends unresolved.** It cuts on a cliffhanger, so the viewer needs to know
   what happens next.
3. **Stands on its own.** It makes sense to someone who has never seen the show.

A promo can be one continuous stretch or several moments joined together, from
one episode or across episodes.

## Approach

Code handles everything that has a right answer. The model handles judgment.

- **Deterministic:** reading the ZIP, parsing scripts, timestamps, durations,
  segment boundaries, and structural checks such as "the hook starts within
  three seconds" and "no dialogue line is cut in half".
- **Model:** spotting hook moments and unresolved endings, judging how strong
  they are, and explaining why.
- **Independent check:** a separate cold-viewer pass sees only what is on screen
  in the promo, with no plot summary, and reports whether it makes sense and
  what the viewer would want to know next.
- **Human in the loop:** an editor reviews the ranked list and makes the final
  call. A local review tool can record blind keep-or-reject ratings to measure
  quality against; none have been collected yet.

Models are called through OpenRouter behind a single adapter, so a different
model or provider can be swapped in through configuration.

## Status

All phases are done: the foundation, deterministic screenplay ingestion, the
evaluation framework with two simple baselines, AI candidate discovery, promo
evaluation and ranking (`rank-3`, the accepted configuration), the editor
workspace, the persistent backend that connects them, release hardening, and
deployment.

**Live app: <https://promolens-five.vercel.app>.** Anyone can try the made-up
show at [`/demo`](https://promolens-five.vercel.app/demo). Analyzing real
screenplays needs an editor sign-in.

Recommendations are AI-evaluated and structurally verified. They have not been
independently rated by a person, and the editorial score is not a measure or
prediction of views. Anything marked "Planned" does not exist yet.

The deployed app has run a real analysis from upload to export on a made-up
show, using Vercel Workflow, PostgreSQL, a private Blob store, and live models
through zero-data-retention routing. See
[what was and was not checked](docs/backend.md#what-was-and-was-not-checked).

The site needs configured credentials to analyze anything. Without them it says
so and refuses, and the whole workflow can still be tried at `/demo`, which is
labelled on screen and uses a made-up show.

| Area                                                     | Status                         |
| -------------------------------------------------------- | ------------------------------ |
| App shell, brand, light and dark themes                  | Built                          |
| Screenplay and promo data contracts (Zod)                | Built                          |
| Secure ZIP ingestion and screenplay parsing              | Built                          |
| Timeline queries for clip boundaries                     | Built                          |
| `screenplays:validate` command                           | Built                          |
| Evaluation rubric, sample, and metrics                   | Built                          |
| Human review tool (local)                                | Built                          |
| Uniform and cue baselines                                | Built                          |
| Human promo labels                                       | Not collected; tool is ready   |
| AI candidate discovery (OpenRouter, strict ZDR)          | Built, run on the full pack    |
| Hybrid pool of AI and baseline clips                     | Built, run on the full pack    |
| Local checks: lint, format, types, tests, build, e2e     | Built                          |
| GitHub Actions workflow for the same checks              | Written, not yet run on GitHub |
| Editor workspace (upload, progress, results, export)     | Built, connected to backend    |
| Screenplay timeline and promo inspector                  | Built, connected to backend    |
| Analysis backend for the web app                         | Built, verified in production  |
| Sign-in, private storage, durable jobs                   | Built, verified in production  |
| Narrative evaluation of candidates                       | Built, run on the full pack    |
| Cold-viewer check and ranking                            | Built, run on the full pack    |
| Shortlist files from the `rank` command (JSON, Markdown) | Built                          |
| CSV and JSON export in the app                           | Built                          |
| Showing multi-segment promos                             | Built                          |
| Generating multi-segment promos                          | Planned                        |
| Saved runs and usage tracking in the app                 | Built, verified in production  |

## The workspace

The app has one screen that moves through upload, progress, results, and
inspection.

- **Upload.** Drag in a ZIP or choose one, up to 25 MB. Nothing is sent until
  you press Analyze.
- **Progress.** Named stages, taken from what the job reports. No invented
  percentages.
- **Results.** Ranked promos with exact timestamps, hook, ending, reason,
  editorial score, warnings, and status: recommended, alternative, needs
  review, or could not be evaluated.
- **Inspect.** A side panel on wide screens and a full-screen view on small
  ones: the evidence behind each claim, the new-viewer check, and a screenplay
  timeline with scenes, the clip's range, and cut warnings. Promos with several
  segments get one timeline each.
- **Export.** CSV for spreadsheets, and JSON in the same format the ranking
  command writes.

`/demo` runs this workflow on a made-up show. Its menu switches between a
finished, partly finished, empty, and failed analysis. The demo never reads the
file you pick and sends nothing anywhere.

A signed-in editor can leave and come back: analyses keep running on the server,
a refresh returns to the same place, and earlier analyses are listed for opening
or deleting. Editors sign in with a name and an access code. See
[Persistent analysis backend](docs/backend.md).

## Getting started

Requirements: Node.js 24 (or 22.12 and later) and npm.

```bash
npm ci
cp .env.example .env.local   # then add your OpenRouter key
npm run dev
```

Open http://localhost:3000.

No API key is needed to run the demo or the tests. Without backend settings, the
home page says analysis is not connected. To analyze screenplays locally with
nothing else to install, see
[Run it locally](docs/backend.md#run-it-locally). Discovery and ranking need an
OpenRouter key, and its account settings must be checked first. See
[AI candidate discovery](docs/discovery.md#before-the-first-live-run).

## Scripts

| Command                                    | What it does                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `npm run dev`                              | Start the development server.                                                                   |
| `npm run build`                            | Create a production build.                                                                      |
| `npm run start`                            | Serve the production build.                                                                     |
| `npm run lint`                             | Run ESLint with zero warnings allowed.                                                          |
| `npm run format`                           | Format files with Prettier.                                                                     |
| `npm run format:check`                     | Check formatting without changing files.                                                        |
| `npm run typecheck`                        | Type-check with TypeScript in strict mode.                                                      |
| `npm test`                                 | Run unit and integration tests with Vitest.                                                     |
| `npm run test:e2e`                         | Run browser and axe accessibility tests with Playwright. Run `npm run build` first.             |
| `npm run test:workflow`                    | Run the real durable workflow in-process with a mock model.                                     |
| `npm run test:e2e:backend`                 | Upload to export on the real app and backend, with a mock model. Run `npm run build` first.     |
| `npm run check`                            | Lint, format check, type check, and unit tests in one go.                                       |
| `npm run access:hash -- name`              | Make a `PROMOLENS_EDITORS` entry. Reads the access code from standard input.                    |
| `npm run db:migrate`                       | Apply database migrations. Nothing does this automatically.                                     |
| `npm run retention:sweep`                  | List what has passed its retention date. Add `-- --apply` to remove it.                         |
| `npm run cloud:verify`                     | Check a real private Blob store with a small made-up object.                                    |
| `npm run bench:backend`                    | Measure backend request times and query counts on synthetic shows with a mock model.            |
| `npm run screenplays:validate -- pack.zip` | Parse a screenplay ZIP and print counts and problems. Never prints script text.                 |
| `npm run eval -- <step> pack.zip`          | Evaluation steps: `sample`, `candidates`, `prepare-review`, `validate`, `metrics`, `report`.    |
| `npm run eval:review -- pack.zip`          | Start the local human review tool on 127.0.0.1.                                                 |
| `npm run discover -- pack.zip --dry-run`   | AI candidate discovery. Drop `--dry-run` to call the model. See the discovery doc.              |
| `npm run rank -- pack.zip --all --dry-run` | Evaluate and rank the candidate pool. Drop `--dry-run` to call the models. See the ranking doc. |

The first time you run browser tests, install the browser:

```bash
npx playwright install chromium
```

CI runs on pushes to `main` and on pull requests: a production dependency
audit, lint, formatting, types, every test suite, the build, and both browser
suites. Backend, workflow, and backend browser tests run on a throwaway
PostgreSQL database. CI uses synthetic screenplays and a mock model, and never
calls a real model.

## Deploying

PromoLens is one Vercel project with PostgreSQL, a private Blob store, and
Vercel Workflow, live at <https://promolens-five.vercel.app>. The steps,
settings, and the checks to run after a deploy are in
[Deploying to Vercel](docs/backend.md#deploying-to-vercel).

## Architecture

One Next.js app (App Router, TypeScript, Tailwind CSS), built to deploy on Vercel.
Pure domain logic lives in `src/domain` with no framework imports, so the same
pipeline can run from an API route or a command-line script.

- [Architecture overview](docs/architecture.md)
- [Screenplay ingestion and parsing](docs/screenplay-parsing.md)
- [Evaluation methodology](docs/evaluation.md)
- [AI candidate discovery](docs/discovery.md)
- [Promo evaluation and ranking](docs/ranking.md)
- [Persistent analysis backend](docs/backend.md)
- [ADR 0001: One Next.js app](docs/adr/0001-single-nextjs-app.md)
- [ADR 0002: Durable backend](docs/adr/0002-durable-backend.md)

## Confidentiality

The screenplays PromoLens was built against are confidential and are not in
this repository. Never commit screenplay files, ZIP packs, text extracted from
them, prompts that contain script text, or raw model outputs. Tests and
documentation use synthetic examples only. `.gitignore` blocks the common paths,
but it is a safety net, not a substitute for care. See
[SECURITY.md](SECURITY.md).

## Context

PromoLens started as a submission for Problem 1 ("Find the Promos") of Kuku's
AI Generalist assignment. It is an independent project and is not affiliated
with or endorsed by Kuku.

## License

[MIT](LICENSE)
