import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "private/**",
    ".workflow-data/**",
    ".workflow-vitest/**",
    ".data/**",
    "src/app/.well-known/**",
    "next-env.d.ts",
  ]),
]);
