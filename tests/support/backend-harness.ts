import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

import { orchestrate } from "../../src/server/analysis/orchestrate";
import {
  buildPool,
  discoverBatch,
  failUnexpected,
  prepare,
  rankSlice,
  type PipelineDeps,
} from "../../src/server/analysis/pipeline";
import { hashAccessCode } from "../../src/server/auth";
import { setBackendForTests, type Backend } from "../../src/server/backend";
import type { BackendConfig } from "../../src/server/config";
import { openDatabase } from "../../src/server/db/client";
import { memoryStore, type ObjectStore } from "../../src/server/storage";
import { answerEveryStage } from "./backend-model";
import { startMockOpenRouter } from "./mock-openrouter";

/**
 * A real backend for tests: PostgreSQL semantics from an in-memory PGlite, the
 * real route handlers, the real pipeline, and a local stand-in for OpenRouter.
 *
 * BACKEND_TEST_DATABASE_URL runs the same tests on a real PostgreSQL server
 * instead. Each harness then creates its own database on that server, applies
 * the checked-in migrations, and drops it on close, so test files never see
 * each other's rows. The URL needs rights to create databases.
 */

const REAL_SERVER = process.env.BACKEND_TEST_DATABASE_URL;

/** A fresh, migrated database on the real server, and a way to remove it. */
async function realDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const server = new URL(REAL_SERVER as string);
  const name = `promolens_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: server.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(server);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
  } finally {
    await pool.end();
  }
  return {
    url: url.toString(),
    drop: async () => {
      const cleanup = new Client({ connectionString: server.toString() });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

export const ORIGIN = "http://promolens.test";
export const CODES = { alice: "alice-test-code-0001", bob: "bob-test-code-00002" } as const;

let hashes: Promise<BackendConfig["editors"]> | null = null;
const editors = () =>
  (hashes ??= Promise.all(
    Object.entries(CODES).map(async ([name, code]) => ({
      name,
      codeHash: await hashAccessCode(code),
    })),
  ));

type Limits = Partial<BackendConfig["limits"]>;
type Route<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;
export type CallOptions = {
  method?: string;
  cookie?: string | undefined;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
};

export function makeRequest(path: string, options: CallOptions = {}): Request {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    host: new URL(ORIGIN).host,
    ...options.headers,
  };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.json !== undefined) headers["content-type"] = "application/json";
  const body = options.json !== undefined ? JSON.stringify(options.json) : options.body;
  return new Request(`${ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(body !== undefined ? { body, duplex: "half" } : {}),
  } as RequestInit);
}

export function call<P>(route: Route<P>, path: string, options: CallOptions = {}, params?: P) {
  return route(makeRequest(path, options), { params: Promise.resolve((params ?? {}) as P) });
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(options: { limits?: Limits; storage?: ObjectStore } = {}) {
  const mock = await startMockOpenRouter(answerEveryStage);
  const real = REAL_SERVER ? await realDatabase() : null;
  const databaseUrl = real?.url ?? "pglite:memory";
  const db = await openDatabase(databaseUrl);
  const storage = options.storage ?? memoryStore();
  const config: BackendConfig = {
    databaseUrl,
    storage: { kind: "local", dir: "unused" },
    editors: await editors(),
    openRouter: { apiKey: "sk-or-test-secret", baseUrl: mock.url },
    limits: {
      jobBudgetUsd: 1.5,
      rollingBudgetUsd: 15,
      jobMaxRequests: 6_000,
      modelConcurrency: 4,
      modelTimeoutMs: 10_000,
      modelAttempts: 1,
      stepBudgetMs: 60_000,
      retentionDays: 30,
      ...options.limits,
    },
  };
  const env: Record<string, string | undefined> = {};
  const deps: PipelineDeps = { db, storage, config, env };

  let stepNumber = 0;
  /** The same ordering the durable workflow uses, run in this process. */
  const runAnalysis = (jobId: string, runId: string = randomUUID()) =>
    orchestrate({
      prepare: () => prepare(deps, jobId, runId),
      discover: (variant, episodes, reads) =>
        discoverBatch(deps, jobId, runId, `d${++stepNumber}:1`, variant, episodes, reads),
      buildPool: () => buildPool(deps, jobId, runId),
      rank: (_slice, rounds) => rankSlice(deps, jobId, runId, `r${++stepNumber}:1`, rounds),
      fail: () => failUnexpected(deps, jobId, runId),
      pause: async () => {},
    });

  const started: string[] = [];
  const backend: Backend = {
    config,
    db,
    storage,
    env,
    startRun: async (jobId) => {
      started.push(jobId);
      await harness.onStart(jobId);
    },
  };
  setBackendForTests(backend);

  const harness = {
    backend,
    deps,
    db,
    storage,
    env,
    config,
    mock,
    started,
    runAnalysis,
    onStart: (jobId: string): Promise<void> => runAnalysis(jobId),
    close: async () => {
      setBackendForTests(null);
      await mock.close();
      if (real) {
        await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
        await real.drop();
      }
    },
  };
  return harness;
}

/** Counts calls per model stage, by the schema name each request asks for. */
export function stageCounts(harness: Harness): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const request of harness.mock.chats()) {
    const name =
      (request.body as { response_format?: { json_schema?: { name?: string } } }).response_format
        ?.json_schema?.name ?? "other";
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}
