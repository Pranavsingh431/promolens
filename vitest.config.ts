import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "tests/integration/**/*.test.ts"],
    // These start a database each. See vitest.backend.config.ts.
    exclude: [...configDefaults.exclude, "tests/integration/backend-*.test.ts"],
    environment: "node",
    setupFiles: ["tests/support/no-network.ts", "tests/support/dom-setup.ts"],
  },
});
