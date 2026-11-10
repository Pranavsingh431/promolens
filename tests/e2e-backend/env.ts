import { scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Everything the controlled test backend needs. All values are made up for tests. */

export const APP_PORT = 3200;
export const MODEL_PORT = 3201;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;
export const MODEL_CONTROL = `http://127.0.0.1:${MODEL_PORT}/__control`;

export const EDITOR = { name: "test-editor", code: "test-only-access-code-1" };
export const OTHER_EDITOR = { name: "other-editor", code: "test-only-access-code-2" };

const hash = (code: string) => {
  const salt = Buffer.alloc(16, 7);
  const key = scryptSync(code, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
};

export const DATA_DIR = join(tmpdir(), "promolens-backend-e2e");

export function backendEnv(dataDir: string, appPort: number, modelPort: number) {
  return {
    // E2E_DATABASE_URL runs the same tests against a real PostgreSQL server.
    DATABASE_URL: process.env.E2E_DATABASE_URL ?? `pglite:${join(dataDir, "db")}`,
    PROMOLENS_STORAGE: "local",
    PROMOLENS_LOCAL_STORAGE_DIR: join(dataDir, "objects"),
    PROMOLENS_EDITORS: `${EDITOR.name}:${hash(EDITOR.code)},${OTHER_EDITOR.name}:${hash(OTHER_EDITOR.code)}`,
    OPENROUTER_API_KEY: "sk-or-test-not-a-real-key",
    OPENROUTER_BASE_URL: `http://127.0.0.1:${modelPort}/api/v1`,
    WORKFLOW_TARGET_WORLD: "local",
    WORKFLOW_LOCAL_DATA_DIR: join(dataDir, "workflow"),
    WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${appPort}`,
    WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS: "0",
    WORKFLOW_LOCAL_BODY_TIMEOUT_MS: "0",
    PORT: String(appPort),
  };
}
