import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { candidateSetSchema } from "../../src/domain/evaluation/candidate";
import { NIGHT_FERRY } from "../support/fixtures";
import { chatReply, startMockOpenRouter, type ChatHandler } from "../support/mock-openrouter";
import { buildZip } from "../support/zip-builder";

const CLI = fileURLToPath(new URL("../../scripts/discover.ts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "promolens-discover-"));
const pack = join(root, "ferry.zip");
writeFileSync(
  pack,
  buildZip(NIGHT_FERRY.map(({ name, text }) => ({ name: `night-ferry/${name}`, data: text }))),
);

const SECRET_TEXT = "MODEL-WROTE-THIS";
const answer = (episode: number) =>
  episode === 1
    ? {
        episodeNotes: SECRET_TEXT,
        proposals: [
          {
            startEvent: 3,
            endEvent: 15,
            hookEvents: [4],
            cliffhangerEvents: [15],
            supportingEvents: [],
            hookType: "curiosity",
            hook: SECRET_TEXT,
            cliffhanger: SECRET_TEXT,
            whyItWorks: SECRET_TEXT,
            contextNeeded: [],
            warnings: [],
          },
        ],
      }
    : { episodeNotes: SECRET_TEXT, proposals: [] };
const episodeOf = (body: { messages: Array<{ content: string }> }) =>
  Number(/^Episode (\d+)/.exec(body.messages[1]?.content ?? "")?.[1]);
const healthy: ChatHandler = (body) => chatReply(answer(episodeOf(body)));

let mock: Awaited<ReturnType<typeof startMockOpenRouter>>;
beforeAll(async () => {
  mock = await startMockOpenRouter(healthy);
});
afterAll(async () => {
  await mock.close();
  rmSync(root, { recursive: true, force: true });
});

/** Runs the CLI asynchronously, so the mock server in this process can answer it. */
function run(args: string[], env: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, pack, ...args], {
      cwd: root,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "sk-or-test",
        OPENROUTER_BASE_URL: mock.url,
        ...env,
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
  expect(out).not.toContain(SECRET_TEXT);
  for (const line of scriptLines) expect(out).not.toContain(line);
};

// These tests start real CLI processes, several per test. Under a full parallel run that
// can pass the 5 s default, so they get a limit suited to process startup.
describe("discover command", { timeout: 30_000 }, () => {
  it("plans a run without any network request", async () => {
    const before = mock.requests.length;
    const { code, out } = await run(["--all", "--dry-run"]);
    expect(code).toBe(0);
    expect(out).toContain("E001 planned");
    expect(out).toContain("No requests were sent.");
    expect(mock.requests.length).toBe(before);
  });

  it("runs every episode with strict private routing and saves results", async () => {
    const { code, out } = await run(["--all"]);
    expect(code).toBe(0);
    expect(out).toContain(
      "Processed 3/3 episodes (3 called, 0 from cache); 1 with at least one valid candidate",
    );
    expect(out).toContain("Routing: google-vertex/global");
    expectNoPrivateText(out);

    const chat = mock.chats();
    expect(chat).toHaveLength(3);
    const body = chat[0]?.body as Record<string, unknown>;
    expect(chat[0]?.authorization).toBe("Bearer sk-or-test");
    expect(body.provider).toEqual({
      zdr: true,
      data_collection: "deny",
      require_parameters: true,
      only: ["google-vertex/global"],
      allow_fallbacks: true,
    });
    expect(body).toMatchObject({
      model: "anthropic/claude-haiku-5.5",
      response_format: { type: "json_schema" },
    });
    expect(Object.keys(body)).not.toEqual(expect.arrayContaining(["tools"]));
    expect(Object.keys(body)).not.toEqual(expect.arrayContaining(["plugins"]));

    const set = candidateSetSchema.parse(
      JSON.parse(
        readFileSync(join(root, "private/evaluation/candidates/ai-writer-context.json"), "utf8"),
      ),
    );
    expect(set.candidates.map((c) => c.id)).toEqual(["ai-writer-context:E001@0004500-0032000"]);
    const runs = readdirSync(join(root, "private/discovery/runs"));
    const manifest = JSON.parse(
      readFileSync(
        join(root, "private/discovery/runs", runs[0] as string, "manifest.json"),
        "utf8",
      ),
    );
    expect(manifest).toMatchObject({
      requestsSent: 3,
      totals: { processed: 3, withCandidates: 1 },
    });
    expect(manifest.routing.privacy).toBe("strict-zdr");

    // The mock bills 1,200 input, 600 output (200 reasoning) tokens and $0.00042 per call.
    expect(out).toContain("Tokens in 3,600, out 1,800 (reasoning 600). Cost $0.0013 billed");
    expect(out).toContain("Requests sent 3.");
    expect(manifest.totals.billedUsd).toBeCloseTo(0.00126, 10);
    expect(manifest.totals.usage).toEqual({
      inputTokens: 3_600,
      outputTokens: 1_800,
      reasoningTokens: 600,
      cachedTokens: 0,
    });
    expect(existsSync(join(root, "private/evaluation/candidates/hybrid.json"))).toBe(true);
  });

  it("keeps failed episodes unfinished, then resumes without repeating finished ones", async () => {
    mock.setChat((body) =>
      episodeOf(body) === 3
        ? { status: 500, body: { error: { code: 500, message: "boom" } } }
        : healthy(body),
    );
    const failed = await run(["--all", "--fresh", "--attempts", "1"]);
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/E003 failed\s+provider/);
    expect(failed.out).toContain("Processed 2/3 episodes");

    mock.setChat(healthy);
    const before = mock.chats().length;
    const resumed = await run(["--resume"]);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain("Processed 3/3 episodes (1 called, 2 from cache)");
    expect(resumed.out).toContain("Tokens in 1,200, out 600 (reasoning 200). Cost $0.0004 billed");
    expect(mock.chats().length - before).toBe(1);
  });

  it("treats a damaged cache entry as missing, reports it, and repairs it", async () => {
    const dir = join(root, "private/discovery/cache");
    const episodeOne = readdirSync(dir).find(
      (name) => JSON.parse(readFileSync(join(dir, name), "utf8")).response.proposals.length === 1,
    );
    writeFileSync(join(dir, episodeOne as string), '{"format":1,"key":');

    const before = mock.chats().length;
    const repaired = await run(["--episodes", "1"]);
    expect(repaired.code).toBe(0);
    expect(repaired.out).toContain("Processed 1/1 episodes (1 called, 0 from cache)");
    expect(repaired.out).toContain("Damaged cache entries ignored: 1.");
    expect(mock.chats().length - before).toBe(1);

    const again = await run(["--episodes", "1"]);
    expect(again.out).toContain("Processed 1/1 episodes (0 called, 1 from cache)");
    expect(mock.chats().length - before).toBe(1);
  });

  it("refuses to send a request the budget cannot cover", async () => {
    const before = mock.chats().length;
    const { code, out } = await run(["--episodes", "1", "--fresh", "--budget", "0.000001"]);
    expect(code).toBe(1);
    expect(out).toMatch(/E001 skipped\s+budget/);
    expect(mock.chats().length).toBe(before);
  });

  it("refuses a model that only has safety-retention endpoints unless told otherwise", async () => {
    const before = mock.chats().length;
    const { code, out } = await run(["--episodes", "1", "--model", "google/safety-only"]);
    expect(code).toBe(2);
    expect(out).toContain("--allow-safety-retention");
    expect(mock.chats().length).toBe(before);
  });

  it("explains setup and usage errors", async () => {
    expect(await run(["--all"], { OPENROUTER_API_KEY: undefined })).toMatchObject({
      code: 2,
      out: expect.stringContaining("Set OPENROUTER_API_KEY"),
    });
    expect((await run([])).code).toBe(2);
    expect((await run(["--split", "held-out"])).code).toBe(2);
    expect((await run(["--all", "--colour"])).code).toBe(2);
    expect((await run(["--episodes", "9"])).code).toBe(2);
    expect(await run(["--resume", "--fresh"])).toMatchObject({
      code: 2,
      out: expect.stringContaining("cannot be combined"),
    });
  });
});
