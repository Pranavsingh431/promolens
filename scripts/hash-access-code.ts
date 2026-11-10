import { createInterface } from "node:readline/promises";

import { hashAccessCode } from "../src/server/auth.ts";

/**
 * Makes one entry for PROMOLENS_EDITORS. The access code is read from standard
 * input so it never appears in shell history.
 *
 *   npm run access:hash -- jamie
 */

const name = process.argv[2] ?? "";
if (!/^[a-z0-9._-]{1,40}$/.test(name)) {
  console.error("Give a lowercase editor name: npm run access:hash -- jamie");
  process.exit(1);
}
const reader = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
process.stderr.write("Access code (at least 12 characters): ");
const code = (await reader.question("")).trim();
reader.close();
if (code.length < 12) {
  console.error("That code is too short. Use at least 12 characters.");
  process.exit(1);
}
console.log(`${name}:${await hashAccessCode(code)}`);
