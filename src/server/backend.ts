import { loadBackendConfig, type BackendConfig } from "./config.ts";
import { openDatabase, type Database } from "./db/client.ts";
import { localFileStore, vercelBlobStore, type ObjectStore } from "./storage.ts";

/**
 * Shared server resources. Null means the deployment is not fully configured,
 * and every protected route then fails closed.
 */

export type Backend = {
  config: BackendConfig;
  db: Database;
  storage: ObjectStore;
  env: Record<string, string | undefined>;
  /** Starts the durable workflow for a job. Injected so tests can run it in-process. */
  startRun: (jobId: string) => Promise<void>;
};

type Cache = { key: string; backend: Promise<Backend> };
const globals = globalThis as unknown as {
  __promolensBackend?: Cache;
  __promolensTestBackend?: Backend;
};

/** For tests only: replaces the real backend, or restores it with null. */
export function setBackendForTests(backend: Backend | null): void {
  if (backend) globals.__promolensTestBackend = backend;
  else delete globals.__promolensTestBackend;
}

async function build(config: BackendConfig): Promise<Backend> {
  const db = await openDatabase(config.databaseUrl);
  const storage =
    config.storage.kind === "vercel-blob" ? vercelBlobStore() : localFileStore(config.storage.dir);
  return {
    config,
    db,
    storage,
    env: process.env,
    startRun: async (jobId) => {
      const { startAnalysisRun } = await import("./start-run.ts");
      await startAnalysisRun(jobId);
    },
  };
}

export async function getBackend(): Promise<Backend | null> {
  if (globals.__promolensTestBackend) return globals.__promolensTestBackend;
  const result = loadBackendConfig(process.env);
  if (!result.ok) return null;
  const key = JSON.stringify(result.config);
  if (globals.__promolensBackend?.key !== key) {
    const backend = build(result.config);
    globals.__promolensBackend = { key, backend };
    // A failed connection must not be remembered, or one outage would last until a restart.
    backend.catch(() => {
      if (globals.__promolensBackend?.backend === backend) delete globals.__promolensBackend;
    });
  }
  return globals.__promolensBackend.backend;
}
