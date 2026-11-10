import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { InferenceError, classifyError, parseRetryAfter } from "./errors";
import { SpendGuard } from "./limits";
import {
  buildRequestBody,
  completeJson,
  describeShape,
  worstCaseUsd,
  type ModelConfig,
} from "./openrouter";

const CONFIG: ModelConfig = {
  baseUrl: "https://example.invalid/api/v1",
  apiKey: "sk-or-test",
  model: "vendor/model",
  maxTokens: 1_000,
  reasoningEffort: "low",
  timeoutMs: 5_000,
  maxAttempts: 3,
  provider: { zdr: true, data_collection: "deny", require_parameters: true, only: ["vendor/eu"] },
  pricing: { inputPerToken: 1e-6, outputPerToken: 2e-6 },
};

const REQUEST = {
  system: "system text",
  user: "user text",
  schemaName: "answer",
  jsonSchema: { type: "object" },
  parse: (value: unknown) => z.object({ ok: z.boolean() }).parse(value),
};

const ok = (content: unknown, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    id: "gen-1",
    provider: "Vendor",
    model: "vendor/model",
    choices: [
      {
        finish_reason: "stop",
        message: { content: typeof content === "string" ? content : JSON.stringify(content) },
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 10 },
      cost: 0.0002,
    },
    ...extra,
  },
});

type Reply =
  { status: number; body?: unknown; raw?: string; headers?: Record<string, string> } | "hang";

function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] as Reply;
    if (reply === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return new Response(reply.raw ?? JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers,
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const run = (
  replies: Reply[],
  config: Partial<ModelConfig> = {},
  extra: Record<string, unknown> = {},
) => {
  const fake = fakeFetch(replies);
  const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {});
  const promise = completeJson(
    REQUEST,
    { ...CONFIG, ...config },
    { fetch: fake.fetch, sleep, random: () => 0.5, ...extra },
  );
  return { promise, fake, sleep };
};
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as InferenceError;
  }
  throw new Error("Expected the call to fail");
};

describe("request body", () => {
  it("asks for strict structured JSON with the given routing, and nothing else", () => {
    const body = buildRequestBody(REQUEST, CONFIG);
    expect(body).toEqual({
      model: "vendor/model",
      messages: [
        { role: "system", content: "system text" },
        { role: "user", content: "user text" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", strict: true, schema: { type: "object" } },
      },
      max_tokens: 1_000,
      reasoning: { effort: "low", exclude: true },
      provider: CONFIG.provider,
      stream: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/tools|plugins|web/);
  });

  it("refuses web-search model variants", () => {
    expect(() => buildRequestBody(REQUEST, { ...CONFIG, model: "vendor/model:online" })).toThrow(
      /Web-search/,
    );
  });
});

describe("successful calls", () => {
  it("returns the validated value with usage, billed cost, and metadata", async () => {
    const { promise, fake } = run([ok({ ok: true })]);
    const result = await promise;
    expect(result.value).toEqual({ ok: true });
    expect(result.spend).toEqual({
      usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 10, cachedTokens: 0 },
      billedUsd: 0.0002,
      estimatedUsd: 100 * 1e-6 + 50 * 2e-6,
      attempts: 1,
    });
    expect(result).toMatchObject({
      generationId: "gen-1",
      provider: "Vendor",
      servedModel: "vendor/model",
    });
    expect(fake.calls[0]?.url).toBe("https://example.invalid/api/v1/chat/completions");
    expect((fake.calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-or-test",
    );
  });

  it("estimates cost when the provider reports none", async () => {
    const reply = ok({ ok: true });
    delete (reply.body.usage as Record<string, unknown>).cost;
    const result = await run([reply]).promise;
    expect(result.spend.billedUsd).toBeNull();
    expect(result.spend.estimatedUsd).toBeCloseTo(0.0002, 10);
  });

  it("accepts JSON wrapped in a code fence", async () => {
    expect((await run([ok('```json\n{"ok":false}\n```')]).promise).value).toEqual({ ok: false });
  });
});

describe("errors that a retry cannot fix", () => {
  it.each([
    [401, "auth"],
    [402, "payment"],
    [400, "invalid-request"],
    [403, "content-policy"],
    [404, "not-found"],
  ])("HTTP %i is %s and is not retried", async (status, kind) => {
    const { promise, fake } = run([{ status, body: { error: { code: status, message: "nope" } } }]);
    const error = await failure(promise);
    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it("does not retry truncated output, a refusal, or a content-filter stop", async () => {
    // Regression: on 2026-11-10 Azure returned finish_reason "content_filter" with a short
    // non-JSON message; it was treated as malformed JSON and retried three times.
    const filtered = ok("The response was filtered.");
    (filtered.body.choices[0] as { finish_reason: string }).finish_reason = "content_filter";
    const truncated = ok({ ok: true });
    (truncated.body.choices[0] as { finish_reason: string }).finish_reason = "length";
    const refusal = ok("");
    (refusal.body.choices[0] as { message: Record<string, unknown> }).message = {
      content: null,
      refusal: "No.",
    };
    for (const [reply, kind] of [
      [truncated, "truncated"],
      [refusal, "refusal"],
      [filtered, "content-policy"],
    ] as const) {
      const { promise, fake } = run([reply]);
      expect((await failure(promise)).kind).toBe(kind);
      expect(fake.calls).toHaveLength(1);
    }
  });
});

describe("errors that are retried", () => {
  it("waits for Retry-After on a rate limit, then succeeds", async () => {
    const { promise, sleep } = run([
      {
        status: 429,
        body: { error: { code: 429, message: "slow down" } },
        headers: { "retry-after": "2" },
      },
      ok({ ok: true }),
    ]);
    expect((await promise).value).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(2_000, undefined);
  });

  it("retries an in-flight budget 402 but not an empty account", async () => {
    const inFlight = {
      status: 402,
      body: {
        error: {
          code: 402,
          message: "busy",
          metadata: { limit_source: "openrouter_in_flight_budget" },
        },
      },
      headers: { "retry-after": "1" },
    };
    expect((await run([inFlight, ok({ ok: true })]).promise).value).toEqual({ ok: true });
  });

  it.each([
    ["malformed body", { status: 200, raw: "not json" }, "malformed-response"],
    [
      "error inside a 200",
      { status: 200, body: { error: { code: 502, message: "upstream died" } } },
      "provider",
    ],
    [
      "finish reason error",
      { status: 200, body: { choices: [{ finish_reason: "error", message: { content: "" } }] } },
      "provider",
    ],
    ["no choices", { status: 200, body: { choices: [] } }, "malformed-response"],
    ["empty content", ok("   "), "empty-completion"],
    ["content that is not JSON", ok("{oops"), "malformed-json"],
    ["JSON that breaks the schema", ok({ ok: "yes" }), "schema-invalid"],
    ["server error", { status: 500, body: { error: { code: 500, message: "boom" } } }, "provider"],
    [
      "no provider for the routing rules",
      { status: 503, body: { error: { code: 503, message: "none" } } },
      "no-provider",
    ],
  ] as const)("retries %s and gives up after the last attempt", async (_label, reply, kind) => {
    const { promise, fake, sleep } = run([reply as Reply]);
    const error = await failure(promise);
    expect(error.kind).toBe(kind);
    expect(error.message).toMatch(/^Gave up after 3 attempts/);
    expect(fake.calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("names the failing field and check, but not the value, when the schema is broken", async () => {
    const { promise } = run([ok({ ok: "a secret line" })], { maxAttempts: 1 });
    const error = await failure(promise);
    expect(error.message).toMatch(/Completion did not match the schema at ok \(invalid_type\)\.$/);
    expect(error.message).not.toContain("secret");
  });

  it("backs off exponentially with jitter", async () => {
    const { promise, sleep } = run([{ status: 500, body: {} }], {}, { random: () => 0 });
    await failure(promise);
    // random() = 0 gives half of the exponential step: 500 ms, then 1000 ms.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1_000]);
  });

  it("gives up at once when Retry-After asks for too long", async () => {
    const { promise, fake } = run([{ status: 429, body: {}, headers: { "retry-after": "600" } }]);
    expect((await failure(promise)).kind).toBe("rate-limit");
    expect(fake.calls).toHaveLength(1);
  });

  it("adds up tokens and cost across attempts, including failed ones", async () => {
    const result = await run([ok({ ok: "bad" }), ok({ ok: true })]).promise;
    expect(result.spend.attempts).toBe(2);
    expect(result.spend.usage.inputTokens).toBe(200);
    expect(result.spend.billedUsd).toBeCloseTo(0.0004, 10);
  });

  it("reports what failed attempts cost", async () => {
    const error = await failure(run([ok({ ok: "bad" })]).promise);
    expect(error.spend).toMatchObject({ attempts: 3, billedUsd: expect.closeTo(0.0006, 10) });
  });
});

describe("timeouts and cancellation", () => {
  it("times out a request that never answers", async () => {
    const { promise } = run(["hang"], { timeoutMs: 20, maxAttempts: 1 });
    expect((await failure(promise)).kind).toBe("timeout");
  });

  it("stops at once when the caller cancels", async () => {
    const controller = new AbortController();
    const { promise, fake } = run(["hang"], {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = await failure(promise);
    expect(error.kind).toBe("aborted");
    expect(fake.calls).toHaveLength(1);
  });
});

describe("spending limits", () => {
  it("refuses a call whose worst case would break the budget", async () => {
    // Worst case: 25 prompt tokens (schema included) and 1000 output tokens, about $0.002.
    const guard = new SpendGuard({ maxCostUsd: 0.001, maxRequests: 10 });
    const { promise, fake } = run([ok({ ok: true })], {}, { guard });
    expect((await failure(promise)).kind).toBe("budget");
    expect(fake.calls).toHaveLength(0);
  });

  it("bounds the worst case by every prompt character, the schema, and the full output limit", () => {
    // 11 + 9 characters of messages and 17 of schema: 37 / 1.5 rounds up to 25 tokens.
    expect(worstCaseUsd(REQUEST, CONFIG)).toBeCloseTo(25 * 1e-6 + 1_000 * 2e-6, 12);
    const withoutSchema = { system: REQUEST.system, user: REQUEST.user };
    expect(worstCaseUsd(withoutSchema, CONFIG)).toBeCloseTo(14 * 1e-6 + 1_000 * 2e-6, 12);
  });

  it("counts every attempt against the request limit", async () => {
    const guard = new SpendGuard({ maxCostUsd: 10, maxRequests: 2 });
    const { promise, fake } = run([{ status: 500, body: {} }], {}, { guard });
    expect((await failure(promise)).kind).toBe("request-limit");
    expect(fake.calls).toHaveLength(2);
    expect(guard.requests).toBe(2);
  });

  it("settles the actual cost after each call", async () => {
    const guard = new SpendGuard({ maxCostUsd: 10, maxRequests: 10 });
    await run([ok({ ok: true })], {}, { guard }).promise;
    expect(guard.spentUsd).toBeCloseTo(0.0002, 10);
    expect(guard.reservedUsd).toBe(0);
  });
});

describe("error helpers", () => {
  it("reads Retry-After as seconds or a date", () => {
    expect(parseRetryAfter("3")).toBe(3_000);
    expect(
      parseRetryAfter("Wed, 11 Nov 2026 00:00:10 GMT", Date.parse("Wed, 11 Nov 2026 00:00:00 GMT")),
    ).toBe(10_000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("keeps messages short and tells overload apart from missing providers", () => {
    const long = classifyError(400, { error: { message: "x".repeat(500) } });
    expect(long.message.length).toBeLessThan(200);
    expect(
      classifyError(503, { error: { metadata: { error_type: "provider_overloaded" } } }).kind,
    ).toBe("provider");
    expect(classifyError(503, {}).kind).toBe("no-provider");
  });
});

describe("broken JSON is described without its text", () => {
  it("names length, edges, and whether one object can be cut out", () => {
    const secret = '{"note":"SECRET LINE"} trailing words';
    const text = describeShape(secret, "stop");
    expect(text).toBe(
      `${secret.length} characters, starts with "{", ends with a letter, one object can be cut out, finish stop`,
    );
    expect(text).not.toContain("SECRET");
    expect(describeShape('{"a":1}{"b":2}', "stop")).toContain("no single object can be cut out");
    expect(describeShape('{"a":', "length")).toContain("no object inside, finish length");
  });
});
