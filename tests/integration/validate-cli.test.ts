import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { NIGHT_FERRY } from "../support/fixtures";
import { buildZip } from "../support/zip-builder";

const CLI = fileURLToPath(new URL("../../scripts/validate-screenplays.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "promolens-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(...args: string[]) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], {
    encoding: "utf8",
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function writeZip(name: string, entries: Parameters<typeof buildZip>[0]) {
  const path = join(dir, name);
  writeFileSync(path, buildZip(entries));
  return path;
}

// These tests start real CLI processes, several per test. Under a full parallel run that
// can pass the 5 s default, so they get a limit suited to process startup.
describe("screenplays:validate", { timeout: 30_000 }, () => {
  const valid = writeZip(
    "valid.zip",
    NIGHT_FERRY.map(({ name, text }) => ({ name: `night-ferry/${name}`, data: text })),
  );

  it("prints statistics and exits 0 for a valid pack, without screenplay text", () => {
    const { code, out } = run(valid);
    expect(code).toBe(0);
    expect(out).toContain("Episodes     3 (1 to 3)");
    expect(out).toContain("Events       31: camera 14, action 4, sound 3, dialogue 10");
    expect(out).toContain("Result: valid.");
    for (const { text } of NIGHT_FERRY) {
      const lines = text
        .split("\n")
        .filter((line) => line.length > 20 && !line.startsWith("Start:"));
      for (const line of lines) expect(out).not.toContain(line);
    }
  });

  it("exits 1 and lists errors for an invalid pack", () => {
    const broken = NIGHT_FERRY.map(({ name, text }) => ({
      name: `night-ferry/${name}`,
      data: text.replace("Start: (00:01.00) | End: (00:04.50)", "Start: (00:01.00) | End: (soon)"),
    }));
    const { code, out } = run(writeZip("broken.zip", broken));
    expect(code).toBe(1);
    expect(out).toContain("error    invalid-timestamp (1)");
    expect(out).toContain("at episode-01.txt:");
    expect(out).toContain("Result: invalid.");
  });

  it("exits 2 for bad usage or an unreadable file", () => {
    expect(run().code).toBe(2);
    expect(run(valid, "--verbose").code).toBe(2);
    expect(run(join(dir, "missing.zip")).code).toBe(2);
  });
});
