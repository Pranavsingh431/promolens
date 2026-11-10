# ADR 0002: Durable analysis on Vercel Workflow, PostgreSQL, and private Blob

## Decision

Run each analysis as a Vercel Workflow, keep jobs in PostgreSQL through Drizzle,
and keep files in a private Vercel Blob store. Stay in the one Next.js app.

## Why

A full analysis takes minutes and many paid calls, so it cannot live in an HTTP
request. Workflow gives checkpoints and retries without a server to run, and it
keeps the deployment a single app, which [ADR 0001](0001-single-nextjs-app.md)
chose.

PostgreSQL decides who wins a race. A partial unique index makes parallel Analyze
requests produce one job, and row locks keep state changes legal. An application
check alone could not promise that across function instances.

The rank-3 engine already resumes from saved judgments, so ranking runs in
time-boxed slices with no change to how it scores anything.

## What we gave up

Local runs use Workflow's Local World, which is meant for development, so local
tests cannot prove behavior on Vercel's managed runtime. PGlite handles one query
at a time, so race tests need a real PostgreSQL server and are kept separate.
