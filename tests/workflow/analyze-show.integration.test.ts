import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { analysisJobs, rateLimits } from "../../src/server/db/schema";
import { analyzeShow } from "../../src/workflows/analyze-show";
import { createHarness, type Harness } from "../support/backend-harness";
import { readJob, resultsOf, signIn, startJob, uploadShow } from "../support/backend-api";
import { answerEveryStage } from "../support/backend-model";
import { buildUnseenShowZip } from "../support/unseen-show";

/** Runs the real durable workflow, including its checkpoints and step retries. */

let h: Harness;
let cookie: string;
let number = 0;

beforeAll(async () => {
  h = await createHarness();
  cookie = await signIn("alice");
});
afterAll(() => h.close());
beforeEach(async () => {
  h.mock.setChat(answerEveryStage);
  await h.db.delete(rateLimits);
});

async function queuedJob(episodes = 2) {
  h.onStart = async () => {};
  const { showId } = await uploadShow(cookie, buildUnseenShowZip(episodes, `wf-${++number}`));
  return (await startJob(cookie, showId)).job.id;
}

const stateOf = async (id: string) =>
  (await h.db.select().from(analysisJobs).where(eq(analysisJobs.id, id)))[0]?.state;

describe("the durable analysis workflow", () => {
  it("runs a whole analysis and writes the result", async () => {
    const jobId = await queuedJob();
    const run = await start(analyzeShow, [jobId]);
    await run.returnValue;
    expect(await stateOf(jobId)).toBe("completed");
    const { ranking } = await (await resultsOf(cookie, jobId)).json();
    expect(ranking.versions.ranking).toBe("rank-4");
    expect((await readJob(cookie, jobId)).state).toBe("completed");
  });

  it("lets only the first of two runs for a job do any work", async () => {
    const jobId = await queuedJob();
    const first = await start(analyzeShow, [jobId]);
    await first.returnValue;
    const calls = h.mock.chats().length;
    const second = await start(analyzeShow, [jobId]);
    await second.returnValue;
    expect(h.mock.chats().length).toBe(calls);
  });

  it("retries a step that failed, and the job still completes", async () => {
    const jobId = await queuedJob();
    const original = h.deps.storage.get;
    let failures = 0;
    h.deps.storage.get = async (key) => {
      if (key.endsWith("source.zip") && failures === 0) {
        failures += 1;
        throw new Error("A brief storage problem");
      }
      return original(key);
    };
    const run = await start(analyzeShow, [jobId]);
    await run.returnValue;
    h.deps.storage.get = original;
    expect(failures).toBe(1);
    expect(await stateOf(jobId)).toBe("completed");
  });

  it("keeps screenplay text out of the workflow's own storage", async () => {
    const dir = process.env.WORKFLOW_LOCAL_DATA_DIR ?? ".workflow-data";
    if (!existsSync(dir)) return;
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const text = readFileSync(path, "latin1");
      expect(text).not.toMatch(/tide tables|struck out in red|sk-or-test-secret/);
    }
  });
});
