import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildHybridSet } from "../../src/domain/discovery/merge";
import { generateCueBased, generateUniform } from "../../src/domain/evaluation/baselines";
import { candidateSetSchema } from "../../src/domain/evaluation/candidate";
import { selectSample } from "../../src/domain/evaluation/sample";
import { rankingOutputSchema } from "../../src/domain/ranking/output";
import { NIGHT_FERRY } from "../support/fixtures";
import { chatReply, startMockOpenRouter, type ChatHandler } from "../support/mock-openrouter";
import {
  fakeCold,
  fakeEditorial,
  fakePair,
  fakeScreen,
  ferryShow,
  ferryTimeline,
} from "../support/ranking";
import { buildZip } from "../support/zip-builder";

const CLI = fileURLToPath(new URL("../../scripts/rank.ts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "promolens-rank-cli-"));
const pack = join(root, "ferry.zip");
const zip = buildZip(
  NIGHT_FERRY.map(({ name, text }) => ({ name: `night-ferry/${name}`, data: text })),
);
writeFileSync(pack, zip);
const sha = createHash("sha256").update(zip).digest("hex");

const candidates = join(root, "private", "evaluation", "candidates");
mkdirSync(candidates, { recursive: true });
const uniform = candidateSetSchema.parse({ ...generateUniform(ferryTimeline), packSha256: sha });
const cues = candidateSetSchema.parse({ ...generateCueBased(ferryTimeline), packSha256: sha });
writeFileSync(join(candidates, "uniform.json"), JSON.stringify(uniform));
writeFileSync(join(candidates, "cues.json"), JSON.stringify(cues));
writeFileSync(
  join(candidates, "hybrid.json"),
  JSON.stringify(buildHybridSet([uniform, cues], ferryTimeline, sha).set),
);
writeFileSync(
  join(root, "private", "evaluation", "sample.json"),
  JSON.stringify(selectSample(ferryShow, sha)),
);

const MODEL_TEXT = "MODEL-WROTE-THIS";
const answer: ChatHandler = (body) => {
  const user = body.messages[1]?.content ?? "";
  const name = (body.response_format as { json_schema?: { name?: string } } | undefined)
    ?.json_schema?.name;
  if (name === "promo_screen") return chatReply(fakeScreen(user, { note: MODEL_TEXT }));
  if (name === "cold_viewer") return chatReply(fakeCold(user, { guesses: [MODEL_TEXT] }));
  if (name === "editorial_judgment")
    return chatReply(fakeEditorial(user, { whyItWorks: MODEL_TEXT }));
  return chatReply(fakePair({ reason: MODEL_TEXT }));
};

let mock: Awaited<ReturnType<typeof startMockOpenRouter>>;
beforeAll(async () => {
  mock = await startMockOpenRouter(answer);
});
afterAll(async () => {
  await mock.close();
  rmSync(root, { recursive: true, force: true });
});

function run(args: string[]) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, pack, ...args], {
      cwd: root,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "sk-or-test-secret",
        OPENROUTER_BASE_URL: mock.url,
      },
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const scriptLines = NIGHT_FERRY.flatMap(({ text }) =>
  text.split("\n").filter((line) => line.startsWith('"') && line.length > 12),
);
const expectNoPrivateText = (out: string) => {
  expect(out).not.toContain(MODEL_TEXT);
  expect(out).not.toContain("sk-or-test-secret");
  for (const line of scriptLines) expect(out).not.toContain(line);
};
const runs = (out: string) => readdirSync(join(root, out, "runs"));

// These tests start real CLI processes, several per test. Under a full parallel run that
// can pass the 5 s default, so they get a limit suited to process startup.
describe("npm run rank on a synthetic pack with a mocked model", { timeout: 30_000 }, () => {
  it("plans without sending anything", async () => {
    const before = mock.chats().length;
    const { code, out } = await run(["--all", "--dry-run", "--out", "private/plan"]);
    expect(code).toBe(0);
    expect(out).toContain("No requests were sent.");
    expect(mock.chats().length).toBe(before);
  });

  it("ranks the show, writes every output, and keeps text off the console", async () => {
    const { code, out } = await run([
      "--all",
      "--top",
      "3",
      "--finalists",
      "4",
      "--out",
      "private/ranking",
    ]);
    expect(code, out).toBe(0);
    expectNoPrivateText(out);
    const [runId] = runs("private/ranking");
    const dir = join(root, "private/ranking/runs", runId ?? "");
    const output = rankingOutputSchema.parse(
      JSON.parse(readFileSync(join(dir, "ranking.json"), "utf8")),
    );
    expect(output.status).toBe("complete");
    expect(output.shortlist.length).toBeGreaterThan(0);
    expect(output.versions.models).toMatchObject({
      screen: "anthropic/claude-haiku-5.5",
      editorial: "openai/gpt-6-luna",
    });
    for (const name of [
      "shortlist.md",
      "judgments.json",
      "manifest.json",
      "promos.json",
      "promos.csv",
    ]) {
      expect(existsSync(join(dir, name))).toBe(true);
    }
    const ranked = candidateSetSchema.parse(
      JSON.parse(readFileSync(join(candidates, "ranked.json"), "utf8")),
    );
    expect(ranked.method).toBe("ranked");
    expect(ranked.candidates[0]?.rank).toBe(1);
    const ledger = JSON.parse(readFileSync(join(root, "private/ranking/ledger.json"), "utf8"));
    expect(ledger.runs).toHaveLength(1);
    expect(ledger.runs[0].status).toBe("finished");
  });

  it("sends only strict, private requests with the right output limit name for each endpoint", () => {
    const notes = ferryShow.episodes.flatMap((e) =>
      [e.writerNotes.logline, e.writerNotes.continuityNotes].filter((n): n is string => Boolean(n)),
    );
    const chats = mock.chats();
    expect(chats.length).toBeGreaterThan(0);
    for (const chat of chats) {
      const body = chat.body as Record<string, unknown> & {
        model: string;
        provider: Record<string, unknown>;
        messages: Array<{ content: string }>;
      };
      expect(body.provider).toMatchObject({
        zdr: true,
        data_collection: "deny",
        require_parameters: true,
      });
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("plugins");
      const text = body.messages.map((m) => m.content).join("\n");
      for (const note of notes) expect(text).not.toContain(note);
      if (body.model === "openai/gpt-6-luna") {
        expect(body.max_completion_tokens).toBeGreaterThan(0);
        expect(body).not.toHaveProperty("max_tokens");
        expect(body.provider.only).toEqual(["azure"]);
      } else {
        expect(body.max_tokens).toBeGreaterThan(0);
        expect(body.provider.only).toEqual(["google-vertex/global"]);
      }
    }
  });

  it("answers a repeat run entirely from the cache", async () => {
    const before = mock.chats().length;
    const { code, out } = await run([
      "--all",
      "--top",
      "3",
      "--finalists",
      "4",
      "--out",
      "private/ranking",
    ]);
    expect(code, out).toBe(0);
    expect(mock.chats().length).toBe(before);
    expect(out).toContain("0 live judgments");
  });

  it("stops at the experiment budget, reports a partial run, and leaves the ranked set alone", async () => {
    const isolated = join(root, "private", "evaluation", "isolated");
    cpSync(candidates, isolated, { recursive: true });
    rmSync(join(isolated, "ranked.json"), { force: true });
    const { code, out } = await run([
      "--all",
      "--experiment-budget",
      "0.003",
      "--out",
      "private/tiny",
      "--candidates-dir",
      "private/evaluation/isolated",
    ]);
    expect(code, out).toBe(1);
    expect(out).toContain("Status: partial");
    expect(existsSync(join(isolated, "ranked.json"))).toBe(false);
    const ledger = JSON.parse(readFileSync(join(root, "private/tiny/ledger.json"), "utf8"));
    expect(ledger.runs[0].spentUsd).toBeLessThanOrEqual(0.003);
  });

  it("records retry causes and fails a judgment cleanly when answers stay invalid", async () => {
    mock.setChat((body) => {
      const name = (body.response_format as { json_schema?: { name?: string } }).json_schema?.name;
      if (name === "cold_viewer") return chatReply({ clarity: 9 });
      return answer(body);
    });
    const { code, out } = await run([
      "--split",
      "development",
      "--out",
      "private/broken",
      "--attempts",
      "2",
    ]);
    mock.setChat(answer);
    expect(code, out).toBe(1);
    expect(out).toMatch(/cold-viewer .*failed attempts: schema-invalid \d+/);
    expectNoPrivateText(out);
  });

  it("refuses to rank held-out episodes on their own", async () => {
    const sample = selectSample(ferryShow, sha);
    const heldOut = sample.episodes.find((e) => e.split === "held-out")?.episode;
    expect(heldOut).toBeDefined();
    const { code, out } = await run(["--episodes", String(heldOut), "--dry-run"]);
    expect(code).toBe(2);
    expect(out).toContain("held-out");
  });

  it("refuses unknown options and web-search models", async () => {
    expect((await run(["--all", "--nope"])).code).toBe(2);
    expect(
      (await run(["--all", "--evaluator", "openai/gpt-6-luna:online", "--dry-run"])).code,
    ).toBe(2);
  });
});
