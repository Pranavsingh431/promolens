import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@vercel/blob", () => ({
  head: vi.fn(async () => ({ url: "https://store.example/uploads/a/b/source.zip" })),
  put: vi.fn(),
  get: blob.get,
  del: vi.fn(),
  list: vi.fn(),
}));

import { vercelBlobStore } from "./storage";

/** A response whose body cancel never settles, like one branch of a teed stream in Next.js. */
function stuckResponse(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: () => new Promise<void>(() => {}) },
  } as unknown as Response;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the Blob store's privacy check", () => {
  // Regression: on 2026-11-10 every upload completion on Vercel hung until the
  // 300 s function limit, because this check awaited the body cancel.
  it("returns without waiting for the body to be cancelled", async () => {
    globalThis.fetch = vi.fn(async () => stuckResponse(403)) as unknown as typeof fetch;
    const store = vercelBlobStore();
    const result = await Promise.race([
      store.isPubliclyReadable?.("uploads/a/b/source.zip"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 1_000)),
    ]);
    expect(result).toBe(false);
  });

  it("reports an object anyone can read, and asks without credentials", async () => {
    const spy = vi.fn(async () => stuckResponse(206));
    globalThis.fetch = spy as unknown as typeof fetch;
    expect(await vercelBlobStore().isPubliclyReadable?.("uploads/a/b/source.zip")).toBe(true);
    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toEqual({ range: "bytes=0-0" });
  });
});

describe("the privacy check when the answer is unclear", () => {
  it.each([401, 403, 404])("treats %i as private", async (status) => {
    globalThis.fetch = vi.fn(async () => stuckResponse(status)) as unknown as typeof fetch;
    expect(await vercelBlobStore().isPubliclyReadable?.("uploads/a/b/source.zip")).toBe(false);
  });

  it.each([302, 429, 500, 503])("refuses to call %i proof of privacy", async (status) => {
    globalThis.fetch = vi.fn(async () => stuckResponse(status)) as unknown as typeof fetch;
    await expect(vercelBlobStore().isPubliclyReadable?.("uploads/a/b/source.zip")).rejects.toThrow(
      /Could not confirm/,
    );
  });

  it("gives the check a deadline", async () => {
    const spy = vi.fn(async () => stuckResponse(403));
    globalThis.fetch = spy as unknown as typeof fetch;
    await vercelBlobStore().isPubliclyReadable?.("uploads/a/b/source.zip");
    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("reading from the Blob store", () => {
  const KEY = "uploads/a/b/source.zip";
  const result = (stream: ReadableStream<Uint8Array> | null, size: number, encoding?: string) => ({
    statusCode: 200,
    stream,
    headers: new Headers(encoding ? { "content-encoding": encoding } : {}),
    blob: { size },
  });
  const ok = (text: string) => result(new Response(text).body, text.length);
  const text = (bytes: Uint8Array | null | undefined) =>
    new TextDecoder().decode(bytes ?? undefined);
  const never = () => new Promise(() => {});
  const limits = { totalMs: 2_000, stallMs: 50, attempts: 3 };

  beforeEach(() => {
    blob.get.mockReset();
  });

  it("retries a read that stalls, then returns the object", async () => {
    blob.get.mockImplementationOnce(never).mockResolvedValueOnce(ok("zip"));
    expect(text(await vercelBlobStore(limits).get(KEY))).toBe("zip");
    expect(blob.get).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last stalled attempt instead of hanging", async () => {
    blob.get.mockImplementation(never);
    await expect(
      vercelBlobStore({ totalMs: 2_000, stallMs: 30, attempts: 2 }).get(KEY),
    ).rejects.toThrow(/timed out/);
    expect(blob.get).toHaveBeenCalledTimes(2);
  });

  it("aborts the request it gave up on, and starts each attempt fresh", async () => {
    const signals: AbortSignal[] = [];
    blob.get.mockImplementation((_key: string, options: { abortSignal: AbortSignal }) => {
      signals.push(options.abortSignal);
      return never();
    });
    await expect(
      vercelBlobStore({ totalMs: 2_000, stallMs: 20, attempts: 2 }).get(KEY),
    ).rejects.toBeDefined();
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("detects a body that goes silent part way, and retries", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("zi"));
      },
    });
    blob.get.mockResolvedValueOnce(result(stalled, 3)).mockResolvedValueOnce(ok("zip"));
    expect(text(await vercelBlobStore({ totalMs: 500, stallMs: 30, attempts: 2 }).get(KEY))).toBe(
      "zip",
    );
    expect(blob.get).toHaveBeenCalledTimes(2);
  });

  it("stops at the overall limit, even with attempts left", async () => {
    blob.get.mockImplementation(never);
    const started = Date.now();
    await expect(
      vercelBlobStore({ totalMs: 60, stallMs: 40, attempts: 50 }).get(KEY),
    ).rejects.toThrow(/timed out/);
    expect(blob.get.mock.calls.length).toBeLessThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not punish a slow read that keeps making progress", async () => {
    const encoder = new TextEncoder();
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const letter of "slowly") {
          await new Promise((resolve) => setTimeout(resolve, 15));
          controller.enqueue(encoder.encode(letter));
        }
        controller.close();
      },
    });
    blob.get.mockResolvedValueOnce(result(slow, 6));
    const store = vercelBlobStore({ totalMs: 1_000, stallMs: 40, attempts: 1 });
    expect(text(await store.get(KEY))).toBe("slowly");
  });

  it.each([
    ["a dropped connection", new TypeError("terminated")],
    ["a server error", new Error("Failed to fetch blob: 503 Service Unavailable")],
    ["rate limiting", new Error("Failed to fetch blob: 429 Too Many Requests")],
  ])("retries %s", async (_name, error) => {
    blob.get.mockRejectedValueOnce(error).mockResolvedValueOnce(ok("zip"));
    expect(text(await vercelBlobStore(limits).get(KEY))).toBe("zip");
    expect(blob.get).toHaveBeenCalledTimes(2);
  });

  it("does not retry an error that will not change", async () => {
    blob.get.mockRejectedValue(new Error("Failed to fetch blob: 403 Forbidden"));
    await expect(vercelBlobStore(limits).get(KEY)).rejects.toThrow(/403/);
    expect(blob.get).toHaveBeenCalledTimes(1);
  });

  it("stops retrying transient errors at the limit", async () => {
    blob.get.mockRejectedValue(new TypeError("fetch failed"));
    await expect(vercelBlobStore(limits).get(KEY)).rejects.toThrow(/fetch failed/);
    expect(blob.get).toHaveBeenCalledTimes(3);
  });

  it("never accepts an object that arrived incomplete", async () => {
    blob.get
      .mockResolvedValueOnce(result(new Response("zi").body, 3))
      .mockResolvedValueOnce(ok("zip"));
    expect(text(await vercelBlobStore(limits).get(KEY))).toBe("zip");
    blob.get.mockReset();
    blob.get.mockResolvedValue(result(new Response("zi").body, 3));
    await expect(vercelBlobStore({ ...limits, attempts: 1 }).get(KEY)).rejects.toThrow(
      /before all of it/,
    );
  });

  it("does not compare a compressed body with its compressed length", async () => {
    blob.get.mockResolvedValueOnce(result(new Response("decompressed").body, 4, "gzip"));
    expect(text(await vercelBlobStore(limits).get(KEY))).toBe("decompressed");
  });

  it("reads an object of unknown length", async () => {
    blob.get.mockResolvedValueOnce(result(new Response("no length header").body, 0));
    expect(text(await vercelBlobStore(limits).get(KEY))).toBe("no length header");
  });

  it("answers null for a missing object without retrying", async () => {
    blob.get.mockResolvedValue(null);
    expect(await vercelBlobStore(limits).get(KEY)).toBeNull();
    expect(blob.get).toHaveBeenCalledTimes(1);
  });
});
