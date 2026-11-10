# Contributing

Thanks for helping. PromoLens is small on purpose, so changes should be too.

## Setup

1. Use Node.js 24 (`.nvmrc`) or 22.12 and later.
2. Install exact dependencies with `npm ci`.
3. Copy `.env.example` to `.env.local` if you need a model key. Most work does
   not.
4. Run `npm run dev` and open http://localhost:3000.

## Before you open a pull request

```bash
npm run check
npm run build
npm run test:e2e           # when you change anything a user sees
npm run test:workflow      # when you change the backend or the workflow
npm run test:e2e:backend   # when you change the backend
```

All of these run in CI and must pass. CI runs the backend tests on PostgreSQL;
to do the same locally, see [Testing](docs/backend.md#testing).

## Ground rules

- **Never commit confidential input.** No screenplay files, ZIP packs, text
  copied from them, prompts that contain script text, or raw model outputs.
  Use synthetic screenplays in `tests/fixtures/`. Screenshots must show
  synthetic data only.
- **Tests never call a real model.** Use fixed mock responses so CI is
  deterministic and needs no key. `tests/support/mock-openrouter.ts` is a
  local stand-in for the API.
- **Keep the privacy routing strict.** Do not loosen the zero-data-retention
  rules in `src/server/inference/routing.ts` to make a model work. Choose
  another model instead.
- **Keep deterministic work in code.** Parsing, timestamps, durations, and
  boundary checks belong in `src/domain` with unit tests, not in prompts.
- **Never use model judgments as labels.** Ranking scores and comparisons are
  model opinions checked by code. Quality claims need human ratings from the
  review tool.
- **Keep local checks no stricter than the schema the model sees.** A Zod
  limit the JSON schema does not state fails whole answers. Read loose model
  output in code (for example, references) and count what cannot be read.
- **Keep keys on the server.** Nothing under `src/components` may read
  environment secrets.
- **Use the design tokens.** Colors, radii, shadows, and fonts come from
  `src/app/globals.css`. Do not add raw color values in components.
- **Add a dependency only when the code that needs it lands.**
- **Never tune on held-out episodes.** Use the development split to study
  failures. Run the held-out split only for final checks; every run is logged.
- **Never store model output as a human judgment.** Annotation files hold only
  ratings a person entered in the review tool.
- **Do not report numbers you did not measure.** Quality claims need a real run
  and, for accuracy, real editor labels.

## Writing

Use short, plain English in code comments, docs, and UI text. Say what a
thing does and why, and skip what is obvious from the code.

## Commits

Write commit messages in the imperative mood, for example
`Add screenplay parser warnings`. Keep each commit focused on one change.
