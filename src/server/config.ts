import { z } from "zod";

/**
 * Everything the backend needs from the environment. Anything missing makes
 * the whole backend report "not configured" and refuse protected work.
 */

export type EditorCredential = { name: string; codeHash: string };

export type BackendConfig = {
  databaseUrl: string;
  storage: { kind: "vercel-blob" } | { kind: "local"; dir: string };
  editors: EditorCredential[];
  openRouter: { apiKey: string; baseUrl: string };
  limits: {
    /** Hard cap for one analysis, across every retry. */
    jobBudgetUsd: number;
    /** Hard cap per editor over the last 30 days. */
    rollingBudgetUsd: number;
    jobMaxRequests: number;
    modelConcurrency: number;
    modelTimeoutMs: number;
    modelAttempts: number;
    /** How long one durable step keeps starting new judgments. */
    stepBudgetMs: number;
    retentionDays: number;
  };
};

const EDITOR_ENTRY =
  /^([a-z0-9._-]{1,40}):(scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+)$/;

export function parseEditors(value: string | undefined): EditorCredential[] {
  if (!value) return [];
  const editors: EditorCredential[] = [];
  for (const raw of value.split(",")) {
    const match = EDITOR_ENTRY.exec(raw.trim());
    if (match) editors.push({ name: match[1] as string, codeHash: match[2] as string });
  }
  return editors;
}

const number = (fallback: number) =>
  z.preprocess((v) => (v === "" || v === undefined ? fallback : v), z.coerce.number().positive());

const limitsSchema = z.object({
  PROMOLENS_JOB_BUDGET_USD: number(1.5),
  PROMOLENS_ROLLING_BUDGET_USD: number(15),
  PROMOLENS_JOB_MAX_REQUESTS: number(6_000),
  PROMOLENS_MODEL_CONCURRENCY: number(4),
  PROMOLENS_MODEL_TIMEOUT_SECONDS: number(120),
  PROMOLENS_MODEL_ATTEMPTS: number(3),
  PROMOLENS_STEP_BUDGET_SECONDS: number(200),
  PROMOLENS_RETENTION_DAYS: number(30),
});

export type ConfigResult = { ok: true; config: BackendConfig } | { ok: false; missing: string[] };

export function loadBackendConfig(env: Record<string, string | undefined>): ConfigResult {
  const missing: string[] = [];
  const onVercel = Boolean(env.VERCEL);

  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl) missing.push("DATABASE_URL");
  else if (onVercel && databaseUrl.startsWith("pglite:")) missing.push("DATABASE_URL (not pglite)");

  const editors = parseEditors(env.PROMOLENS_EDITORS);
  if (editors.length === 0) missing.push("PROMOLENS_EDITORS");

  const apiKey = env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) missing.push("OPENROUTER_API_KEY");

  let storage: BackendConfig["storage"] | null = null;
  if (env.PROMOLENS_STORAGE === "local") {
    if (onVercel) missing.push("PROMOLENS_STORAGE (local is not allowed on Vercel)");
    else if (!env.PROMOLENS_LOCAL_STORAGE_DIR) missing.push("PROMOLENS_LOCAL_STORAGE_DIR");
    else storage = { kind: "local", dir: env.PROMOLENS_LOCAL_STORAGE_DIR };
  } else if (env.PROMOLENS_STORAGE === "vercel-blob") {
    const credentials = Boolean(env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID);
    if (!credentials) missing.push("BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN");
    // The Blob SDK's presigned-upload handler (2.9.0) refuses every request without
    // this key, even though PromoLens uses no upload callback. Without it, every
    // browser upload would fail, so the setup is reported as incomplete instead.
    if (!env.BLOB_WEBHOOK_PUBLIC_KEY) missing.push("BLOB_WEBHOOK_PUBLIC_KEY");
    if (credentials && env.BLOB_WEBHOOK_PUBLIC_KEY) storage = { kind: "vercel-blob" };
  } else {
    missing.push("PROMOLENS_STORAGE");
  }

  const limits = limitsSchema.safeParse(env);
  if (!limits.success) missing.push("a PROMOLENS_ limit is not a positive number");

  if (missing.length || !storage || !limits.success) return { ok: false, missing };
  const l = limits.data;
  return {
    ok: true,
    config: {
      databaseUrl,
      storage,
      editors,
      openRouter: { apiKey, baseUrl: env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1" },
      limits: {
        jobBudgetUsd: l.PROMOLENS_JOB_BUDGET_USD,
        rollingBudgetUsd: l.PROMOLENS_ROLLING_BUDGET_USD,
        jobMaxRequests: Math.floor(l.PROMOLENS_JOB_MAX_REQUESTS),
        modelConcurrency: Math.floor(l.PROMOLENS_MODEL_CONCURRENCY),
        modelTimeoutMs: l.PROMOLENS_MODEL_TIMEOUT_SECONDS * 1000,
        modelAttempts: Math.floor(l.PROMOLENS_MODEL_ATTEMPTS),
        stepBudgetMs: l.PROMOLENS_STEP_BUDGET_SECONDS * 1000,
        retentionDays: Math.floor(l.PROMOLENS_RETENTION_DAYS),
      },
    },
  };
}
