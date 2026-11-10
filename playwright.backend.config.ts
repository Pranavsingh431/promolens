import { rmSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

import { APP_PORT, APP_URL, DATA_DIR, backendEnv, MODEL_PORT } from "./tests/e2e-backend/env";

// The real app against a real database and storage, with a mock model service.
// Run `npm run build` first. Worker processes reload this file, so only the main one clears data.
if (!process.env.TEST_WORKER_INDEX) rmSync(DATA_DIR, { recursive: true, force: true });

export default defineConfig({
  testDir: "tests/e2e-backend",
  testMatch: "*.spec.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  timeout: 180_000,
  reporter: process.env.CI ? [["github"]] : "list",
  globalSetup: "./tests/e2e-backend/global-setup.ts",
  use: { baseURL: APP_URL, trace: "retain-on-failure", acceptDownloads: true },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run start -- --port ${APP_PORT} --hostname 127.0.0.1`,
    url: APP_URL,
    reuseExistingServer: false,
    timeout: 90_000,
    env: backendEnv(DATA_DIR, APP_PORT, MODEL_PORT),
  },
});
