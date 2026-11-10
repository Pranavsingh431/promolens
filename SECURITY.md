# Security

## Reporting a problem

Please report security problems privately through GitHub: open the
**Security** tab of this repository and choose **Report a vulnerability**. Do
not open a public issue for security problems.

Include what you found, how to reproduce it, and what an attacker could do with
it. Do not include confidential screenplay text or real API keys in the report.

## Rules for secrets and private data

- Model provider keys may be read only by server code. They must never be sent
  to the browser, logged, or written to exported files.
- `.env` and `.env.*` files are ignored by git. Only `.env.example`, which holds
  placeholder values, is tracked.
- Screenplay packs and anything derived from them are ignored by git and by
  Vercel CLI deployments. Tests and documentation use synthetic data.
- CI does not have access to a model key and never calls a real model. A test
  setup file fails any request to a host other than the local machine.

## The web workspace

- A chosen file stays in the browser until the editor presses Analyze. The
  browser's checks only save a wasted upload. The server must enforce every rule
  itself.
- Screenplay and model text is untrusted and is always rendered as plain text.
  CSV cells that a spreadsheet would run as formulas are neutralized.
- The app has no analytics, session replay, or other third-party scripts.
- `/demo` holds only made-up data. No route serves private run output, and
  production builds publish no browser source maps.
- Tests keep server code out of the browser in two ways. One follows every
  import, including dynamic ones, from each client module and fails if it
  reaches `src/server`, `src/workflows`, or a server-only package (`pg`,
  Drizzle, PGlite, the Blob server SDK, `workflow`, Node built-ins). The other
  reads every built file under `.next/static` and fails on server-only names or
  anything shaped like a key, token, database URL, or access-code hash. The
  browser does use `@vercel/blob/client` to upload with a URL the server signed;
  that library names its environment variables, but a browser has no values.
- Analysis needs a signed-in editor. If any credential is missing, the app
  refuses all protected work rather than running open. See
  [Persistent analysis backend](docs/backend.md#access-control).

## Uploaded screenplays

- Uploads go only to private storage, under keys the server generates. No route
  returns a storage URL, and no response is publicly cacheable.
- Each upload is read back and fully checked on the server before it is trusted,
  including every archive safety check and a test that the storage host refuses
  anonymous reads.
- Editors can see only their own shows, jobs, and results. Another editor's item
  answers exactly like one that does not exist.
- Logs have a closed list of fields and cannot carry prompts, model answers,
  screenplay text, keys, or session tokens.
- The Workflow SDK adds routes under `/.well-known/workflow/`. Its manifest and
  any webhook URL answer 404, and a browser test checks that. On Vercel, the
  SDK's documentation says the flow route is reachable only by Vercel Queue.
  Locally it has no authentication, so a local production server should listen
  on 127.0.0.1 only (`npm run start -- --hostname 127.0.0.1`), as the test
  servers do.
- The deployed app was verified against its real private store on 2026-11-10:
  anonymous reads answer 403, and the store refuses bodies over 25 MB. After
  changing the store or its settings, run `npm run cloud:verify` again.

## Sending screenplays to a model

- Requests go only to OpenRouter endpoints on its zero-data-retention list,
  with data collection denied and every parameter required. Endpoints with
  Google Safety Retention are refused unless a run opts in with
  `--allow-safety-retention`, which is recorded in the run manifest.
- If no eligible endpoint exists, the run stops. It never falls back to a
  weaker endpoint or another provider on its own.
- Requests carry no tools, plugins, or web search. Screenplay text is marked
  as data, and the prompt tells the model to ignore instructions inside it.
- Request settings cannot override logging turned on for the account. Before
  the first live run, someone signed in to the OpenRouter account must confirm
  that input and output logging and any prompt sharing or training options are
  off, and that no observability integration copies prompts elsewhere.
- The discovery and rank commands never print prompts, screenplay text, or
  model output. Their run files, caches, ledgers, shortlists, and candidates
  are written under the git-ignored `private/` folder.
- Ranking sends each model only what its stage needs. The cold-viewer stage
  gets the clip's own events and nothing else; no stage gets writer notes,
  episode numbers, scene headings, or source event ids. Ranking supports only
  strict zero-data-retention routing; it has no option to accept safety
  retention.

## Known dependency advisories

Checked on 2026-11-10 with `npm audit` and `npm audit --omit=dev`.

| Scope                     | High or critical | Moderate | Advisories                                                 |
| ------------------------- | ---------------- | -------- | ---------------------------------------------------------- |
| All dependencies          | 0                | 31       | minimatch GHSA-g3hv-75wg-m249, esbuild GHSA-67mh-4wv8-2f99 |
| Production (`--omit=dev`) | 0                | 20       | minimatch GHSA-g3hv-75wg-m249                              |

- **minimatch** (denial of service through a crafted glob pattern). It reaches
  production through the Workflow SDK's build and command-line tools and
  `@vercel/queue`, and the development tree through ESLint. An attack needs a
  malicious glob pattern, and every glob here comes from package or project
  configuration, never from a user. The fixed `minimatch` is a new major
  version the affected packages do not accept, and npm's only automatic fix is
  downgrading `workflow` to 2.0.6, a breaking change. Revisit when the Workflow
  SDK and typescript-eslint accept a fixed version.
- **esbuild** (its development server accepts requests from any site). It comes
  from an old esbuild inside `drizzle-kit`, a development tool. Nothing here
  runs esbuild's server.

**Overrides.** Two are in `package.json`, and `npm ls --all` reports a valid tree:

- `zod` is forced to 4.6.7 everywhere. Without it, the Workflow SDK and the
  Vercel tooling resolve zod 4.5.4 and 4.1.11, which have a high-severity
  advisory (GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized collections).
  This runs those packages one minor version above the range they declare
  (`~4.5.4`, `4.1.11`), within zod 4. The workflow tests pass with it.
- `undici` is forced to 7.30.2 only inside `@workflow/world-local` and
  `@workflow/world-vercel`, which pin 7.30.0, so it is a patch update.
  `@vercel/blob` keeps undici 6.29.1 and jsdom keeps 8.12.4, both inside their
  declared ranges. (An earlier global override ran `@vercel/blob` on undici 7,
  outside its range, with no gain in the audit.)

If you find a real key or confidential script text anywhere in the repository
history, report it the same way so it can be rotated and removed.
