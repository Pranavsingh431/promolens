import { fileURLToPath } from "node:url";

import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";

// The real durable workflow, in-process, with a mock model service. Kept apart
// from `npm test` because it builds workflow bundles and takes longer.
export default defineConfig({
  plugins: [workflow()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/workflow/**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    setupFiles: ["tests/support/no-network.ts"],
  },
});
