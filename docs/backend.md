# Persistent analysis backend

This describes how the web app runs a real analysis: how a ZIP gets in, how the
work survives restarts, where results live, and what stops it spending too much.

Recommendations are AI-evaluated and structurally verified. No person has rated
them, and the editorial score does not measure or predict views. There are no
human ranking labels.

## What was and was not checked

Everything here has been run locally against a real PostgreSQL server, PGlite,
private storage, and a mock model service. It has also been run on the live
deployment at <https://promolens-five.vercel.app>, checked on 2026-11-10:

| Checked in production                                     | Result                                         |
| --------------------------------------------------------- | ---------------------------------------------- |
| Direct browser upload to the private Blob store           | Works, including exactly 25 MB                 |
| Upload completion, 15 runs from 50 KB to 25 MB            | 15 of 15, each under 1.2 s                     |
| A stored file read with no credentials                    | 403 every time                                 |
| Over 25 MB: a ticket, and a body that lied about its size | Both refused                                   |
| Completion with no session, or as another editor          | 401 and 404                                    |
| A repeated completion, and a damaged file                 | 404, and 422 with the file removed             |
| A full analysis of a new made-up 4-episode show           | Completed in 172 s, 87 requests, $0.0366       |
| Managed Workflow run, and a refresh during processing     | Both worked                                    |
| Exact timecodes, evidence, CSV, JSON, and full report     | Checked against the source and the schemas     |
| The same show again                                       | Same job reopened, no paid calls               |
| Another editor, anonymous, and cross-site requests        | 404, 401, and 403                              |
| Model routing on the live run                             | Strict zero data retention, explicit allowlist |

Not exercised: a server crash on Vercel's managed runtime (the crash test runs
locally), a signed upload URL used after its 15 minutes, and any show larger
than the 4-episode test on the deployed app. The full 50-episode pack was
analyzed from the command line with the same engine, and was not run again here.

## How the pieces fit

```
Browser
  | sign in, upload, start, poll, results
  v
Route handlers (src/app/api)      auth, origin check, rate limit, input validation
  |                  |
  v                  v
PostgreSQL        Private object storage          Durable workflow (src/workflows)
  jobs, shows       ZIP, parsed episodes,           prepare, discover, build pool,
  audit, spend      results, manifest               rank in time-boxed slices
  cached answers           ^                                 |
       ^                   |                                 v
       +-------------------+------ pipeline (src/server/analysis) ---> OpenRouter
                                   calls the existing engine            strict ZDR only
```

The pipeline adds no parsing, discovery, or ranking logic of its own. It calls
`ingestScreenplayZip`, the baselines, `runDiscovery`, `buildHybridSet`,
`buildRankingPool`, and `runRanking`. The rank-3 weights, gates, pairwise method,
diversity rules, and boundary checks are exactly the ones in
[Promo evaluation and ranking](ranking.md).

## The workflow

An analysis runs as a durable workflow, so no HTTP request holds it open. Only
ids cross step boundaries, so no screenplay text enters workflow state.

| Step       | What it does                                                                         |
| ---------- | ------------------------------------------------------------------------------------ |
| Prepare    | Claims the job, verifies the file's checksum, parses it, stores parsed episodes.     |
| Discover   | Runs the model over batches of 8 episodes, for each of two prompt variants.          |
| Build pool | Rebuilds candidates from saved answers and makes the same pool the CLI makes.        |
| Rank       | Runs screening, cold viewer, editorial, pairwise, and diversity in repeated slices.  |
| Finalize   | Validates the outputs, writes them under the attempt, and flips the job in one move. |

**Why ranking runs in slices.** A function has a time limit, and a full ranking
can run longer. `runRanking` already resumes from saved judgments, so each slice
stops starting new work after `PROMOLENS_STEP_BUDGET_SECONDS` and the next slice
carries on. The default of 200 seconds plus a 45-second grace period for calls
in flight fits the 300-second function limit.

**Retries are safe.** The platform may run a step twice. Each step re-checks the
job and reuses saved answers, so a repeated step costs nothing. A workflow run
must first claim the job, so a duplicate run stops without doing any work.
Results are written under the attempt number, so a retry cannot overwrite the
results of an earlier attempt.

## Job states

`queued`, `validating`, `parsing`, `discovering`, `evaluating`, `ranking`, then
one of `completed`, `partial`, `failed`, or `cancelled`. The legal moves are in
`src/domain/analysis-job.ts`, enforced under a row lock, and every move writes an
audit row holding only states and an error category.

`uploading` is shown by the browser while the file is in flight. A job row exists
only once the file has been received and verified, so a stored job does not sit
in that state.

Progress is what the server actually knows: episodes searched, moments evaluated,
comparisons made. There are no percentages.

| Failure                | Meaning                                      | Can retry |
| ---------------------- | -------------------------------------------- | --------- |
| `invalid-archive`      | The stored file no longer matches, or is bad | No        |
| `unsupported-format`   | The screenplays could not be parsed          | No        |
| `no-episodes`          | Nothing looked like a screenplay             | No        |
| `too-large`            | Over a size limit                            | No        |
| `provider-unavailable` | Key, payment, or no eligible private route   | Yes       |
| `model-output-invalid` | Answers kept failing validation              | Yes       |
| `budget-reached`       | The job's spending limit was hit             | No        |
| `storage-unavailable`  | The file could not be read                   | Yes       |
| `missing-result`       | A stored result has gone                     | Yes       |
| `workflow-start`       | The workflow could not be started            | Yes       |
| `interrupted`          | A step kept crashing                         | Yes       |
| `internal`             | Anything else                                | Yes       |

**Partial results** are honest. If some episodes got no answer, or ranking ran
out of budget or retries after evaluating some clips, the job ends as `partial`
with a note saying what is missing. A provider refusal is recorded and shown as
"could not be evaluated". No score is ever made up for it.

## Database

PostgreSQL through Drizzle, with typed queries and checked-in migrations in
`drizzle/`. The schema is `src/server/db/schema.ts`.

| Table             | Holds                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| `editors`         | One row per editor name                                                |
| `sessions`        | A SHA-256 of each session token, and its expiry                        |
| `uploads`         | Upload tickets, each tied to one owner and one storage key             |
| `shows`           | Checksum, normalized content hash, size, episode count, retention date |
| `analysis_jobs`   | State, facts, attempt, workflow run, result keys                       |
| `job_events`      | The audit trail of state changes                                       |
| `job_spend`       | Money, requests, tokens, and judgment counts for each workflow step    |
| `inference_cache` | Validated model answers, scoped to owner and show                      |
| `rate_limits`     | Fixed-window counters                                                  |

Two constraints do the important work. `shows` is unique on owner and normalized
content hash, which is how a duplicate upload is found. `analysis_jobs` has a
partial unique index on owner and identity for jobs that are not failed or
cancelled, so parallel Analyze requests can only ever produce one job.

The identity of an analysis is a hash of the owner, the normalized content, the
model settings, every prompt and schema version, the ranking and pool config,
and the pipeline version. Change any of those and it counts as a new analysis.

The normalized hash ignores how the ZIP was packed, so a renamed or repacked copy
of the same screenplays reuses the earlier work.

Apply migrations yourself with `npm run db:migrate`. Nothing runs them on deploy.

## Storage

All objects sit behind the small `ObjectStore` interface in
`src/server/storage.ts`. Keys are built only from ids the server generated.

| Key                                             | Object                     |
| ----------------------------------------------- | -------------------------- |
| `uploads/<owner>/<upload>/source.zip`           | The original ZIP           |
| `shows/<owner>/<show>/parsed/show.json`         | The parsed show            |
| `shows/<owner>/<show>/parsed/episodes/<n>.json` | One parsed episode         |
| `jobs/<owner>/<job>/<attempt>/pool.json`        | The candidate pool         |
| `jobs/<owner>/<job>/<attempt>/ranking.json`     | Full ranking output        |
| `jobs/<owner>/<job>/<attempt>/promos.json`      | Promo export               |
| `jobs/<owner>/<job>/<attempt>/manifest.json`    | Provenance, routing, usage |

**How an upload works on Vercel.** A function cannot accept a 25 MB body, so the
browser sends the file directly to Blob.

1. `POST /api/uploads` records a ticket and returns the key the server chose.
2. `POST /api/uploads/presign` checks that the key belongs to this editor's open
   ticket, then signs one URL for that one object: `put` only, ZIP only, at most
   25 MB, valid for 15 minutes, no overwrite.
3. The browser uploads to that URL in one request. Multipart upload is refused,
   because live testing showed the store enforces the size limit on a single
   upload but not on a multipart one.
4. `POST /api/uploads/:id/complete` is where trust begins. The server reads the
   object back, asks the store for it with no credentials and refuses it if that
   works, computes its checksum, and runs the full ingest with every archive
   safety check. A rejected file is deleted at once.

The upload's privacy does not rest on the `access: "private"` option the browser
sends. It comes from the store being a private store, and step 4 checks it for
every upload. The store must be created as private, and if it was not, uploads
are refused rather than exposed.

Files never go in `public/`, and no route returns a storage URL.

If storage cannot be read, or cannot confirm the file is private, the file is not
accepted: completion answers 503 and the file stays for another try. An answer of
401, 403, or 404 to the anonymous request is the only proof of privacy accepted.

**Reading from Blob.** A 25 MB read took under 1 s in the store's own region, and
anywhere from 3 s to a steady 187 s from far away. So each read may run for up to
240 s in total as long as data keeps arriving. If 15 s pass with no data, the
request is cancelled and tried again, up to three attempts, and a dropped
connection, a short read, or a server-side status is also retried. An object that
arrives shorter than its stated length is never accepted.

With `PROMOLENS_STORAGE=local`, the browser sends the file to
`PUT /api/uploads/:id/content`, which stops reading at 25 MB. Vercel refuses this
setting.

## Access control

Each editor has a name and an access code. The code's scrypt hash is in
`PROMOLENS_EDITORS`, so no password is stored anywhere in plain form. Make an
entry with `npm run access:hash -- your-name`.

- A session is 32 random bytes in an HttpOnly, SameSite=Lax cookie named
  `__Host-promolens-session`, marked Secure. Only local storage, which Vercel
  refuses, uses a plain cookie, because local development runs over http.
- Sessions last 12 hours. Sign-in issues a new token and revokes the one
  presented, which rules out session fixation.
- Every write checks Origin and `Sec-Fetch-Site` as CSRF protection.
- Sign-in, uploads, analysis, retries, reads of results, and exports are rate
  limited in PostgreSQL, so limits hold across instances.
- Every read and write checks the owner. Another editor's resource answers
  exactly like one that does not exist.

**It fails closed.** If `DATABASE_URL`, `PROMOLENS_EDITORS`, the storage settings,
or `OPENROUTER_API_KEY` is missing, every API route answers 503, and the home page
says analysis is not connected. `/demo` stays public and holds only made-up data.
No result from `/demo` can reach a real session.

## API

Every route needs a session, except signing in. Errors are
`{ "error": { "code", "message" } }`. Inputs are checked with Zod, and JSON bodies
over 16 KB are refused.

| Method and path                        | Does                                        |
| -------------------------------------- | ------------------------------------------- |
| `POST /api/session`                    | Sign in.                                    |
| `DELETE /api/session`                  | Sign out and revoke the session.            |
| `POST /api/uploads`                    | Start an upload.                            |
| `POST /api/uploads/presign`            | Sign a direct upload (Blob storage only).   |
| `PUT /api/uploads/:id/content`         | Send the file (local storage only).         |
| `POST /api/uploads/:id/complete`       | Verify the file and record the show.        |
| `GET /api/analyses`                    | List this editor's analyses.                |
| `POST /api/analyses`                   | Start an analysis, or reuse the same one.   |
| `GET /api/analyses/:id`                | Status. Supports `If-None-Match`.           |
| `POST /api/analyses/:id/cancel`        | Cancel.                                     |
| `POST /api/analyses/:id/retry`         | Run again, reusing saved answers.           |
| `GET /api/analyses/:id/results`        | Stored `ranking` and `promos`.              |
| `GET /api/analyses/:id/episodes/:n`    | One source episode, without writer notes.   |
| `GET /api/analyses/:id/export?format=` | `promos-csv`, `promos-json`, `ranking-json` |
| `DELETE /api/shows/:id`                | Delete a show and everything made from it.  |

Sensitive responses are `private, no-store`. Results and episodes are immutable,
so they are `private, no-cache` with an ETag and `Vary: Cookie`: only that browser
keeps them, and it must recheck with the server, which verifies the owner.

The browser polls the status endpoint at the interval the server suggests (2, 4,
then 8 seconds as a job ages), backs off to 15 seconds while nothing changes,
sends no requests from a hidden tab, and stops at a final state.

## Cost controls

- Every paid call goes through `SpendGuard`, which reserves money before a call.
- `PROMOLENS_JOB_BUDGET_USD` is a hard cap per analysis, across every retry.
- `PROMOLENS_ROLLING_BUDGET_USD` is a hard cap per editor over 30 days.
- `PROMOLENS_JOB_MAX_REQUESTS` and `PROMOLENS_MODEL_CONCURRENCY` limit calls.
- While a step runs, its `job_spend` row holds spent plus reserved money. If the
  step crashes, that upper bound stays counted, so a recovery cannot overspend.
- Validated answers are cached by content, prompt, schema, and model, scoped to
  owner and show. A repeated analysis, retry, or replayed step reuses them.
  Answers are never shared between editors.
- Refusals are remembered and not sent again.
- Billed and estimated cost are stored separately, and the manifest keeps them.

Redis is not used.

## Privacy

Requests use the same routing as the command-line tools: only OpenRouter
endpoints on its zero-data-retention list, `data_collection: deny`, an explicit
provider allowlist, and no tools or web access. If no eligible endpoint exists,
the job fails rather than using a weaker one. Keys stay on the server.

Limits on what this guarantees: routing settings cannot override logging turned
on in the OpenRouter account, so the account settings described in
[AI candidate discovery](discovery.md#before-the-first-live-run) must stay off.
Text sent to a model is seen by that provider under its zero-retention terms.

Logs have a closed list of fields (`src/server/log.ts`): ids, counts, durations,
categories, tokens, and cost. There is no field that can carry a prompt, an
answer, dialogue, a key, or a session token.

## Retention and deletion

| What                              | Kept for                                                  |
| --------------------------------- | --------------------------------------------------------- |
| ZIP, parsed episodes              | Until the show is deleted or its retention date passes.   |
| Model answers, results, manifests | The same. They are deleted with the show.                 |
| Jobs that did not finish          | The same.                                                 |
| Uploads never completed           | 15 minutes, then eligible for the sweep.                  |
| Temporary files                   | None. Functions work in memory.                           |
| Structured logs                   | Whatever the host keeps. They hold no screenplay content. |

`PROMOLENS_RETENTION_DAYS` defaults to 30. Editors can delete a show at any time.
A delete checks ownership, refuses while a job is running, clears storage first,
and then removes the rows, so a failure part way can be repeated.

`npm run retention:sweep` lists what has expired and changes nothing. Add
`-- --apply` to remove it. It never touches a show with a running job. Nothing
runs it on a schedule, so someone has to run it.

## Run it locally

No cloud account is needed. Put this in `.env.local`, and never commit it:

```bash
DATABASE_URL=pglite:.data/db
PROMOLENS_STORAGE=local
PROMOLENS_LOCAL_STORAGE_DIR=.data/objects
PROMOLENS_EDITORS=your-name:scrypt$...   # from npm run access:hash -- your-name
OPENROUTER_API_KEY=...                   # analysis calls a real, paid model
```

Then `npm run build && npm run start -- --hostname 127.0.0.1`. Keep the
hostname: locally, workflows run on the Workflow SDK's Local World, whose
`/.well-known/workflow/v1/flow` route has no authentication, and `next start`
otherwise listens on every network interface. PGlite applies migrations by itself. An
interrupted analysis resumes when the server starts again. To avoid paid calls,
set `OPENROUTER_BASE_URL` to a mock. `.data/` and `.workflow-data/` hold
confidential material, and git and Vercel ignore them.

## Deploying to Vercel

The live deployment was set up this way. Nothing provisions it automatically. A
Blob store, a database, and function usage can all incur charges, so the project
owner creates them with their own Vercel account and the Vercel CLI.

**Project**

1. `vercel login`, then `vercel link` in the repository to create or link one
   project. The web app and the backend deploy together.
2. In **Settings**, then **Environment Variables**, select **Enable access to
   System Environment Variables**. Workflow finds the deployment through
   `VERCEL_DEPLOYMENT_ID`; without it, it falls back to its local world and
   every run fails on the read-only filesystem. The same switch provides
   `VERCEL`, which the configuration uses to refuse PGlite and local storage.
3. Keep Fluid compute on, as the Workflow documentation expects. The workflow's
   function limit is 300 seconds on Hobby and 800 on Pro; the ranking slices are
   sized for 300.

**Resources and variables**

| Variable                  | Value                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`            | Pooled PostgreSQL connection string.                             |
| `DATABASE_URL_UNPOOLED`   | Direct connection, if the provider gives one. Migrations use it. |
| `PROMOLENS_STORAGE`       | `vercel-blob`                                                    |
| `BLOB_STORE_ID`           | From connecting a **private** Blob store to the project.         |
| `BLOB_WEBHOOK_PUBLIC_KEY` | Also from connecting the store. Uploads fail without it.         |
| `PROMOLENS_EDITORS`       | `name:hash` entries from `npm run access:hash -- name`.          |
| `OPENROUTER_API_KEY`      | Server-side only. Never prefix it with `NEXT_PUBLIC_`.           |

The `PROMOLENS_` limits in `.env.example` are optional. Do not set
`WORKFLOW_PUBLIC_MANIFEST`: it publishes the list of workflow and step names.
Do not add a Next.js proxy or middleware that matches
`/.well-known/workflow/`; the Workflow documentation says that breaks it.

If any required variable is missing, every API route answers 503 and the home
page says analysis is not connected. Sessions use a `__Host-`, Secure, HttpOnly,
SameSite=Lax cookie whenever storage is not `local`, so no extra setting is
needed for secure cookies.

**Before the first deploy**

4. `npm run db:migrate` with the production database URL. Nothing runs it on
   deploy.
5. `npm run cloud:verify` with the store's credentials (for example after
   `vercel env pull`). All four lines must say PASS.

**After a deploy**

6. Sign in, upload a made-up show, and run one analysis to the end. Refresh
   while it runs and after it finishes: the job and results must come back.
7. Upload a file close to 25 MB through the browser.
8. Check the upload restrictions against the real store. Each needs a request
   crafted outside the app, because the app never sends one:
   - a second upload to the same signed URL after the first succeeded is
     refused (no overwrite);
   - a signed URL used after 15 minutes is refused;
   - a body over 25 MB, or with a content type other than `application/zip`,
     is refused by the store;
   - `POST /api/uploads/presign` for a key that belongs to another editor, or
     to an upload already completed, answers 404.
9. Workflow routes: `GET /.well-known/workflow/v1/manifest.json` and any
   `/.well-known/workflow/v1/webhook/<token>` must answer 404, and a request to
   `/.well-known/workflow/v1/flow` from outside must not run anything. The
   Workflow documentation says the Vercel World makes the flow handler reachable
   only by Vercel Queue, and a request from outside was answered 404 in production.
10. Check that no response from `/api/` is cached publicly (`private` in every
    `Cache-Control`), and that the Workflow runs appear in the Vercel dashboard.

## Testing

| Command                    | Covers                                                     |
| -------------------------- | ---------------------------------------------------------- |
| `npm test`                 | Everything below that needs no build, on in-memory PGlite. |
| `npm run test:workflow`    | The real durable workflow, in-process, with a mock model.  |
| `npm run test:e2e`         | The public site and demo in a browser.                     |
| `npm run test:e2e:backend` | Upload to export on the real app, and a server kill.       |
| `npm run bench:backend`    | Timings and query counts on synthetic shows. Not a test.   |

Real PostgreSQL, all with a throwaway server and test-only credentials:

- `TEST_DATABASE_URL` turns on the race tests. It names a database with
  migrations applied.
- `BACKEND_TEST_DATABASE_URL` runs every backend test on the server instead of
  PGlite. Each test file creates its own database, applies the migrations, and
  drops it afterward, so the URL needs rights to create databases.
- `E2E_DATABASE_URL` runs the backend browser tests on a freshly migrated
  database. Use a new one for each run, because the tests expect shows they
  have never seen.

CI runs the race tests on PostgreSQL 16 and everything else on PGlite, and
never calls a real model.

## Measured locally

`npm run bench:backend` on 2026-11-10: Node 24.19.0, an Apple Silicon laptop,
in-process route handlers, an in-memory object store, and a mock model, so
these are server work only, with no network and no real model.

| Request on a finished 50-episode show | PostgreSQL 14 median | PGlite median | Queries |
| ------------------------------------- | -------------------- | ------------- | ------- |
| Status                                | 0.9 ms               | 1.5 ms        | 2       |
| List analyses                         | 1.1 ms               | 1.7 ms        | 2       |
| Results (313 KB)                      | 1.3 ms               | 2.0 ms        | 3       |
| Results, unchanged (304)              | 1.2 ms               | 1.9 ms        | 3       |
| One source episode                    | 1.5 ms               | 2.3 ms        | 3       |
| Export promo CSV                      | 9.0 ms               | 8.9 ms        | 3       |
| Export promo JSON                     | 8.9 ms               | 9.6 ms        | 3       |

Parsing a synthetic show took 3 ms for 5 episodes and 17 ms for 50, and
receiving and validating its upload 12 to 34 ms on PostgreSQL. Eight parallel
requests to analyze the same new show made one job and one set of model calls,
and a renamed copy of a finished show reused its job with no model calls. A
real analysis is dominated by model latency, which a mock does not measure.
