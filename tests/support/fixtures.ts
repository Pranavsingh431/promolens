import { readdirSync, readFileSync } from "node:fs";

const FIXTURE_DIR = new URL("../fixtures/screenplays/night-ferry/", import.meta.url);

/** The synthetic three-episode show used across tests. */
export const NIGHT_FERRY = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".txt"))
  .sort()
  .map((name) => ({ name, text: readFileSync(new URL(name, FIXTURE_DIR), "utf8") }));

export function fixtureText(name: string): string {
  const fixture = NIGHT_FERRY.find((item) => item.name === name);
  if (!fixture) throw new Error(`Missing fixture ${name}`);
  return fixture.text;
}
