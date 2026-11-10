import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Backend measurements on synthetic shows with a mock model. Not part of `npm test`:
// run `npm run bench:backend`. See tests/perf/backend.perf.ts.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/perf/**/*.perf.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
    setupFiles: ["tests/support/no-network.ts"],
  },
});
