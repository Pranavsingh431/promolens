import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { buildUnseenShowZip } from "../support/unseen-show";
import { backendEnv, EDITOR, MODEL_CONTROL, MODEL_PORT } from "./env";

/**
 * Kills the server outright while an analysis is running, then starts it again.
 * The job has to finish from its checkpoints, with no finished work repeated.
 */

const PORT = 3210;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await sleep(250);
  }
}

test("a server killed mid-analysis finishes the job after restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "promolens-recovery-"));
  const env = {
    ...process.env,
    ...backendEnv(dataDir, PORT, MODEL_PORT),
    NODE_ENV: "production" as const,
  };
  const launch = () =>
    spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--port",
        String(PORT),
        "--hostname",
        "127.0.0.1",
      ],
      {
        env,
        stdio: "ignore",
      },
    );
  const up = () => waitUntil(async () => ((await fetch(ORIGIN)).ok ? true : null), 60_000);
  const stop = (child: ChildProcess) =>
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  const control = (path: string, body?: unknown) =>
    fetch(`${MODEL_CONTROL}/${path}`, {
      method: body ? "POST" : "GET",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const stats = async () => (await (await control("stats")).json()) as { discovery: number };

  let server = launch();
  try {
    await up();
    const signIn = await fetch(`${ORIGIN}/api/session`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: EDITOR.name, code: EDITOR.code }),
    });
    const cookie = (signIn.headers.get("set-cookie") as string).split(";")[0] as string;
    const send = (path: string, init: RequestInit = {}) =>
      fetch(`${ORIGIN}${path}`, {
        ...init,
        headers: { origin: ORIGIN, cookie, "content-type": "application/json", ...init.headers },
      });

    const zip = buildUnseenShowZip(3, "the-recovery-show");
    const ticket = await (
      await send("/api/uploads", {
        method: "POST",
        body: JSON.stringify({ fileName: "recovery.zip", sizeBytes: zip.length }),
      })
    ).json();
    await send(`/api/uploads/${ticket.uploadId}/content`, {
      method: "PUT",
      body: zip as BodyInit,
    });
    const { showId } = await (
      await send(`/api/uploads/${ticket.uploadId}/complete`, { method: "POST" })
    ).json();

    await control("mode", { mode: "hold-evaluation" });
    const { job } = await (
      await send("/api/analyses", { method: "POST", body: JSON.stringify({ showId }) })
    ).json();

    await waitUntil(async () => {
      const { job: seen } = await (await send(`/api/analyses/${job.id}`)).json();
      return seen.state === "evaluating" ? true : null;
    }, 60_000);
    const beforeKill = await stats();
    expect(beforeKill.discovery).toBeGreaterThan(0);

    await stop(server);
    await control("mode", { mode: "healthy" });
    server = launch();
    await up();

    const finished = await waitUntil(async () => {
      const response = await send(`/api/analyses/${job.id}`);
      if (!response.ok) return null;
      const { job: seen } = await response.json();
      return ["completed", "partial", "failed"].includes(seen.state) ? seen : null;
    }, 120_000);
    expect(finished.state).toBe("completed");

    // The sign-in, the job, and the finished discovery all survived the crash.
    expect((await stats()).discovery).toBe(beforeKill.discovery);
    const results = await send(`/api/analyses/${job.id}/results`);
    expect(results.status).toBe(200);
    const { ranking } = await results.json();
    expect(ranking.versions.ranking).toBe("rank-4");
  } finally {
    await control("mode", { mode: "healthy" });
    await stop(server).catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});
