import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The real route handlers and pipeline on an in-memory database. Each file starts
// its own database, so they run one at a time instead of competing for the CPU.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/integration/backend-*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["tests/support/no-network.ts"],
  },
});
