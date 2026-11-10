// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { job, zipFile } from "../../tests/support/analysis-service";
import { createHttpService, whenDocumentVisible } from "./http-service";
import { ServiceError } from "./service";

const uploadPresigned = vi.hoisted(() => vi.fn());
vi.mock("@vercel/blob/client", () => ({ uploadPresigned }));

const UPLOAD = "11111111-1111-4111-8111-111111111111";
const running = job("evaluating", { id: "job-1", pollAfterMs: 2_000 });

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
const calls: Array<{ url: string; init: RequestInit }> = [];
let replies: Reply[];

beforeEach(() => {
  calls.length = 0;
  replies = [];
  uploadPresigned.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const reply = replies.shift() ?? { status: 500, body: {} };
      const status = reply.status ?? 200;
      const noBody = status === 304 || status === 204;
      return new Response(noBody ? null : JSON.stringify(reply.body ?? {}), {
        status,
        ...(reply.headers ? { headers: reply.headers } : {}),
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const failingWith = async (reply: Reply) => {
  replies = [reply];
  return createHttpService()
    .getJob("job-1")
    .then(
      () => {
        throw new Error("expected a failure");
      },
      (error: ServiceError) => error,
    );
};
const ticket = (transport: "server" | "direct") => ({
  status: 201,
  body: { uploadId: UPLOAD, transport, pathname: `uploads/a/${UPLOAD}/source.zip` },
});
const startReplies = (transport: "server" | "direct"): Reply[] => [
  ticket(transport),
  ...(transport === "server" ? [{ body: { received: 2 } }] : []),
  { body: { showId: "show-1", episodes: 3, duplicate: false } },
  { status: 201, body: { job: running } },
];

describe("sending a file", () => {
  it("creates, sends, completes, and starts, in that order", async () => {
    replies = startReplies("server");
    const progress = vi.fn();
    const file = zipFile("show.zip", "pk");
    const result = await createHttpService().startAnalysis(file, { onUploadProgress: progress });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST /api/uploads",
      `PUT /api/uploads/${UPLOAD}/content`,
      `POST /api/uploads/${UPLOAD}/complete`,
      "POST /api/analyses",
    ]);
    expect(calls[1]?.init.body).toBe(file);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      fileName: "show.zip",
      sizeBytes: 2,
    });
    expect(progress).toHaveBeenCalledWith({ loadedBytes: 2, totalBytes: 2 });
    expect(result).toEqual(running);
  });

  it("uses a private direct upload when the server asks for one", async () => {
    replies = startReplies("direct");
    uploadPresigned.mockImplementation(async (_path, _file, options) => {
      options.onUploadProgress({ loaded: 1, total: 2, percentage: 50 });
      return {};
    });
    const progress = vi.fn();
    await createHttpService().startAnalysis(zipFile(), { onUploadProgress: progress });
    expect(uploadPresigned).toHaveBeenCalledOnce();
    const [path, , options] = uploadPresigned.mock.calls[0] as [
      string,
      File,
      Record<string, unknown>,
    ];
    expect(path).toBe(`uploads/a/${UPLOAD}/source.zip`);
    expect(options).toMatchObject({
      access: "private",
      handleUploadUrl: "/api/uploads/presign",
      contentType: "application/zip",
      multipart: false,
    });
    expect(progress).toHaveBeenCalledWith({ loadedBytes: 1, totalBytes: 2 });
    expect(calls.some((c) => c.url.includes("/content"))).toBe(false);
  });

  it("does not complete an upload that did not finish", async () => {
    replies = startReplies("direct");
    uploadPresigned.mockRejectedValue(new Error("Connection reset"));
    await expect(createHttpService().startAnalysis(zipFile(), {})).rejects.toMatchObject({
      kind: "network",
      retryable: true,
    });
    expect(calls.map((c) => c.url)).toEqual(["/api/uploads"]);
  });

  it("shows the server's own explanation of what was wrong with a file", async () => {
    replies = [
      ticket("server"),
      { body: { received: 2 } },
      {
        status: 422,
        body: { error: { code: "invalid-archive", message: "Not a ZIP we can open." } },
      },
    ];
    await expect(createHttpService().startAnalysis(zipFile(), {})).rejects.toMatchObject({
      kind: "invalid-file",
      message: "Not a ZIP we can open.",
    });
  });
});

describe("what the server says is checked before it is used", () => {
  it("refuses a job that does not match the contract", async () => {
    replies = [{ body: { job: { id: "x", state: "made-up-state" } } }];
    await expect(createHttpService().getJob("x")).rejects.toMatchObject({
      kind: "invalid-response",
    });
  });

  it("refuses an episode that does not match the contract", async () => {
    replies = [{ body: { episode: { number: 1 } } }];
    await expect(createHttpService().getEpisode("j", 1)).rejects.toMatchObject({
      kind: "invalid-response",
    });
  });

  it("never substitutes anything when the server cannot answer", async () => {
    replies = [{ status: 500, body: { error: { code: "server", message: "Broken" } } }];
    await expect(createHttpService().getResults("j")).rejects.toBeInstanceOf(ServiceError);
    expect(calls).toHaveLength(1);
  });
});

describe("errors the editor can act on", () => {
  it.each([
    [401, "unauthorized", "unauthorized", false],
    [404, "not-found", "not-found", false],
    [410, "missing-result", "not-found", false],
    [413, "too-large", "invalid-file", false],
    [415, "invalid-archive", "invalid-file", false],
    [422, "no-episodes", "invalid-file", false],
    [429, "rate-limited", "rate-limited", true],
    [429, "budget-reached", "rate-limited", false],
    [503, "not-configured", "unavailable", false],
    [500, "server", "server", true],
    [409, "not-ready", "server", false],
  ])("%i %s becomes %s (retryable: %s)", async (status, code, kind, retryable) => {
    const error = await failingWith({ status, body: { error: { code, message: "m" } } });
    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(retryable);
  });

  it("copes with an error that has no readable body", async () => {
    const error = await failingWith({ status: 500, body: "plain" });
    expect(error).toMatchObject({ kind: "server", retryable: true });
  });

  it("calls a dropped connection a network problem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(createHttpService().getJob("j")).rejects.toMatchObject({
      kind: "network",
      retryable: true,
    });
  });

  it("lets a cancellation stay a cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("Aborted", "AbortError");
      }),
    );
    await expect(createHttpService().getJob("j")).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("following a running analysis", () => {
  const etag = { etag: '"job-1-5"' };

  it("asks only for what changed, and waits longer while nothing does", async () => {
    const service = createHttpService();
    replies = [{ body: { job: running }, headers: etag }];
    await service.getJob("job-1");
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      replies = [{ status: 304 }];
      delays.push((await service.getJob("job-1")).pollAfterMs);
    }
    expect(calls[1]?.init.headers).toMatchObject({ "if-none-match": '"job-1-5"' });
    expect(delays[0]).toBe(3_000);
    expect(delays[1]).toBeGreaterThan(delays[0] as number);
    expect(Math.max(...delays)).toBe(15_000);
  });

  it("goes back to the server's pace when something changes", async () => {
    const service = createHttpService();
    replies = [{ body: { job: running }, headers: etag }];
    await service.getJob("job-1");
    replies = [{ status: 304 }];
    await service.getJob("job-1");
    replies = [{ body: { job: running }, headers: { etag: '"job-1-6"' } }];
    expect((await service.getJob("job-1")).pollAfterMs).toBe(2_000);
  });

  it("never lets the browser store status responses", async () => {
    replies = [{ body: { job: running } }];
    await createHttpService().getJob("job-1");
    expect(calls[0]?.init.cache).toBe("no-store");
  });
});

describe("results, exports, and history", () => {
  it("rechecks stored results with the server rather than reusing them blindly", async () => {
    replies = [{ body: { ranking: {}, promos: {} } }];
    await createHttpService().getResults("job-1");
    expect(calls[0]?.url).toBe("/api/analyses/job-1/results");
    expect(calls[0]?.init.cache).toBe("no-cache");
  });

  it("uses the server's file name and type for a download", async () => {
    replies = [
      {
        body: { a: 1 },
        headers: {
          "content-disposition": 'attachment; filename="promolens-x-promos.json"',
          "content-type": "application/json",
        },
      },
    ];
    const file = await createHttpService().exportResults("job-1", "promos-json");
    expect(file).toEqual({
      fileName: "promolens-x-promos.json",
      mimeType: "application/json",
      content: '{"a":1}',
    });
  });

  it("cancels, retries, lists, and deletes through their own endpoints", async () => {
    const service = createHttpService();
    replies = [
      { body: { job: job("cancelled") } },
      { body: { job: job("queued") } },
      {
        body: {
          analyses: [{ job: running, showId: "s", createdAt: "2026-01-01", finishedAt: null }],
        },
      },
      { status: 204 },
    ];
    expect((await service.cancelJob("job-1")).state).toBe("cancelled");
    expect((await service.retryJob?.("job-1"))?.state).toBe("queued");
    expect(await service.listJobs?.()).toHaveLength(1);
    await service.deleteShow?.("s");
    expect(calls.map((c) => `${c.init.method ?? "GET"} ${c.url}`)).toEqual([
      "POST /api/analyses/job-1/cancel",
      "POST /api/analyses/job-1/retry",
      "GET /api/analyses",
      "DELETE /api/shows/s",
    ]);
  });

  it("has no route to the demo's made-up results", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(`${process.cwd()}/src/client/http-service.ts`, "utf8");
    expect(source).not.toMatch(/demo/i);
  });
});

describe("a tab that is out of view", () => {
  const setVisibility = (state: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => setVisibility("visible"));

  it("waits until the tab is back", async () => {
    setVisibility("hidden");
    let resumed = false;
    const waiting = whenDocumentVisible(new AbortController().signal).then(() => {
      resumed = true;
    });
    await Promise.resolve();
    expect(resumed).toBe(false);
    setVisibility("visible");
    await waiting;
    expect(resumed).toBe(true);
  });

  it("continues at once when the tab is visible", async () => {
    setVisibility("visible");
    await expect(whenDocumentVisible(new AbortController().signal)).resolves.toBeUndefined();
  });

  it("stops waiting if the analysis is abandoned", async () => {
    setVisibility("hidden");
    const controller = new AbortController();
    const waiting = whenDocumentVisible(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});
