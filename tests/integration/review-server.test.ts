import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateCueBased, generateUniform } from "../../src/domain/evaluation/baselines";
import { prepareBlindReview } from "../../src/domain/evaluation/review";
import { selectSample } from "../../src/domain/evaluation/sample";
import { assembleShow } from "../../src/domain/screenplay/assemble-show";
import { parseEpisode } from "../../src/domain/screenplay/parse-episode";
import type { Show } from "../../src/domain/screenplay/schema";
import { createTimeline } from "../../src/domain/screenplay/timeline";
import { createReviewServer } from "../../src/server/evaluation/review-server";
import { NIGHT_FERRY } from "../support/fixtures";

const show = assembleShow(
  "night-ferry",
  NIGHT_FERRY.map(({ name, text }) => parseEpisode({ path: `night-ferry/${name}`, text })),
).show as Show;
const timeline = createTimeline(show);
const sample = selectSample(show, "d".repeat(64));
const { items } = prepareBlindReview(
  [generateUniform(timeline), generateCueBased(timeline)],
  [1, 2, 3],
  {
    perMethodPerEpisode: 2,
    seed: 5,
    sampleVersion: sample.version,
  },
);

const dir = mkdtempSync(join(tmpdir(), "promolens-review-"));
let server: Server;
let base = "";

beforeAll(async () => {
  server = createReviewServer({
    dir,
    timeline,
    sample,
    items,
    now: () => "2026-11-10T10:00:00.000Z",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string) => fetch(`${base}${path}`);
const put = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const rating = {
  ratings: { hook: 2, cliffhanger: 3, clarity: 3, emotion: 2, boundaries: 2 },
  decision: "keep",
  mainReason: "strong-cliffhanger",
  weaknesses: [],
  notes: "",
};

describe("review server", () => {
  it("serves the page and the session without the review key", async () => {
    expect((await get("/")).headers.get("content-type")).toContain("text/html");
    const session = await (await get("/api/session")).json();
    expect(session.episodes).toEqual([1, 2, 3]);
    expect(session.items).toEqual(items.items.map((i) => i.itemId));
    expect(JSON.stringify(session)).not.toMatch(/uniform|cues|E00\d@/);
  });

  it("shows sampled episodes only", async () => {
    expect((await get("/api/episodes/1")).status).toBe(200);
    expect((await get("/api/episodes/4")).status).toBe(404);
  });

  it("shows a Part B clip without its episode, position, or method", async () => {
    const body = await (await get(`/api/items/${items.items[0]?.itemId}`)).text();
    expect(body).not.toMatch(/"episode"|E00\d|uniform|cues|clipKey/);
    expect(JSON.parse(body).parts[0].events.length).toBeGreaterThan(0);
  });

  it("saves, resumes, and rejects stale or invalid saves", async () => {
    const empty = await (await get("/api/annotations/R1")).json();
    expect(empty.revision).toBe(0);

    const first = { ...empty, partB: [{ itemId: items.items[0]?.itemId, judgment: rating }] };
    const saved = await put("/api/annotations/R1", { baseRevision: 0, file: first });
    expect(saved.status).toBe(200);
    const result = await saved.json();
    expect(result.revision).toBe(1);
    expect(JSON.stringify(result.file)).not.toContain("clipKey");

    const resumed = await (await get("/api/annotations/R1")).json();
    expect(resumed.partB).toEqual([
      {
        itemId: items.items[0]?.itemId,
        judgment: rating,
        version: 1,
        updatedAt: "2026-11-10T10:00:00.000Z",
      },
    ]);

    expect((await put("/api/annotations/R1", { baseRevision: 0, file: first })).status).toBe(409);

    const badKeep = {
      ...resumed,
      partB: [
        {
          itemId: items.items[0]?.itemId,
          judgment: { ...rating, ratings: { ...rating.ratings, clarity: 1 } },
        },
      ],
    };
    expect((await put("/api/annotations/R1", { baseRevision: 1, file: badKeep })).status).toBe(400);

    const tooShort = {
      ...resumed,
      partA: [
        {
          episode: 1,
          status: "in-progress",
          moments: [
            {
              id: "M-E001-01",
              segments: [{ episode: 1, startMs: 0, endMs: 10_000 }],
              judgment: rating,
            },
          ],
        },
      ],
    };
    const rejected = await put("/api/annotations/R1", { baseRevision: 1, file: tooShort });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).issues[0].message).toMatch(/20 to 60 s/);
  });

  it("checks a selection for length and cut lines", async () => {
    const response = await fetch(`${base}/api/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ segments: [{ episode: 1, startMs: 10_500, endMs: 40_000 }] }),
    });
    expect((await response.json()).issues).toEqual([
      { severity: "warning", path: "", message: "Starts in the middle of a spoken line." },
    ]);
  });

  it("refuses bad reviewer codes and requests for another host name", async () => {
    expect((await get("/api/annotations/..%2Fsecret")).status).toBe(400);
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${base}/api/session`);
      const req = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: { host: "attacker.example" },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe("a review round limited to one split", () => {
  it("still shows a final recommendation from an unsampled episode", async () => {
    const unsampled = {
      itemId: "B999",
      clipKey: "E099@0000000-0025000",
      segments: [{ episode: 99, startMs: 0, endMs: 25_000 }],
    };
    const context = {
      dir,
      timeline,
      sample,
      items: { ...items, items: [...items.items, unsampled] },
      only: [1],
    };
    const limited = createReviewServer(context);
    await new Promise<void>((resolve) => limited.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
    try {
      const session = (await (await fetch(`${url}/api/session`)).json()) as { items: string[] };
      expect(session.items).toContain("B999");
    } finally {
      limited.close();
    }
  });

  it("shows only that split's episodes and clips", async () => {
    const only = [1];
    const limited = createReviewServer({ dir, timeline, sample, items, only });
    await new Promise<void>((resolve) => limited.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
    try {
      const session = (await (await fetch(`${url}/api/session`)).json()) as {
        episodes: number[];
        items: string[];
      };
      expect(session.episodes).toEqual([1]);
      const expected = items.items.filter((i) => i.segments.every((s) => s.episode === 1));
      expect(session.items).toEqual(expected.map((i) => i.itemId));
      expect((await fetch(`${url}/api/episodes/2`)).status).toBe(404);
      const hidden = items.items.find((i) => i.segments.some((s) => s.episode !== 1));
      if (hidden) expect((await fetch(`${url}/api/items/${hidden.itemId}`)).status).toBe(404);
    } finally {
      limited.close();
    }
  });
});
