# ADR 0001: One Next.js app instead of a separate frontend and backend

- Status: Accepted
- Date: 2026-11-09

## Context

PromoLens needs a web interface for editors, server-side code that holds API
keys and calls models, and an analysis pipeline that parses screenplays and
ranks promos. It must deploy on a free tier, be easy for one developer to run,
and work reliably when run on a new show during a live review.

The usual alternative is a React frontend plus a separate API service, for
example a Python or Node backend on its own host.

## Decision

Build one Next.js (App Router) application in TypeScript and deploy it to
Vercel.

- Pages and components live in `src/app` and `src/components`.
- API route handlers in `src/app` stay thin and call into `src/domain`.
- The pipeline lives in `src/domain` as plain TypeScript with no framework
  imports, so a CLI script can run it without the web server.
- Server-only adapters (model calls, storage) live in `src/server`.

## Why

- **One deploy, one set of types.** The same Zod schemas validate model output
  on the server and describe data in the UI. A separate backend would need a
  shared package or duplicated types.
- **Keys stay on the server by default.** Route handlers run on the server, so
  the OpenRouter key never needs to reach the browser.
- **Less to break in a live run.** One process to start locally, one project to
  deploy, no cross-origin setup, no second hosting account.
- **The work is I/O bound.** Analysis time is dominated by model calls, not CPU,
  so Node is not a bottleneck and a Python service buys nothing yet.
- **Domain code is portable.** Because `src/domain` has no Next.js imports, it
  can move into a worker or service later without a rewrite.

## Consequences

- Serverless functions have time limits. A full 50-episode analysis may exceed
  them, so long runs will need a durable background workflow. That is planned,
  not built.
- The UI and API scale together. That is fine at editor-tool volume.
- Revisit this decision if analysis needs heavy CPU or GPU work, a Python-only
  library, or independent scaling from the UI.
