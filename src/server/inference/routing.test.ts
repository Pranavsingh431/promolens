import { describe, expect, it } from "vitest";

import { SpendGuard, Semaphore } from "./limits";
import { planRouting } from "./routing";

const endpoint = (overrides: Record<string, unknown>) => ({
  model_id: "vendor/model",
  tag: "vendor/eu",
  provider_name: "Vendor",
  status: 0,
  safety_retention: false,
  supported_parameters: ["structured_outputs", "response_format", "max_tokens"],
  pricing: { prompt: "0.0000001", completion: "0.0000005" },
  ...overrides,
});

const listing = (data: unknown[]) =>
  (async () => new Response(JSON.stringify({ data }), { status: 200 })) as unknown as typeof fetch;

const plan = (data: unknown[], privacy: "strict-zdr" | "allow-safety-retention" = "strict-zdr") =>
  planRouting("vendor/model", privacy, {
    baseUrl: "https://example.invalid/api/v1",
    fetch: listing(data),
  });

describe("planRouting", () => {
  it("routes only to strict zero-retention endpoints with structured outputs, and denies data collection", async () => {
    const result = await plan([
      endpoint({ tag: "vendor/us", pricing: { prompt: "0.0000002", completion: "0.0000006" } }),
      endpoint({}),
      endpoint({ tag: "vendor/safety", safety_retention: true }),
      endpoint({ tag: "vendor/plain", supported_parameters: ["response_format"] }),
      endpoint({ tag: "vendor/down", status: -2 }),
      endpoint({ model_id: "other/model", tag: "other/eu" }),
    ]);
    expect(result.provider).toEqual({
      zdr: true,
      data_collection: "deny",
      require_parameters: true,
      only: ["vendor/eu", "vendor/us"],
      allow_fallbacks: true,
    });
    // The highest price among allowed endpoints is used for reservations.
    expect(result.pricing).toEqual({ inputPerToken: 2e-7, outputPerToken: 6e-7 });
  });

  it("refuses safety-retention endpoints in strict mode and says how to opt in", async () => {
    await expect(plan([endpoint({ safety_retention: true })])).rejects.toMatchObject({
      kind: "no-provider",
      message: expect.stringContaining("--allow-safety-retention"),
    });
  });

  it("allows safety-retention endpoints only when asked, and records that", async () => {
    const result = await plan([endpoint({ safety_retention: true })], "allow-safety-retention");
    expect(result.privacy).toBe("allow-safety-retention");
    expect(result.endpoints).toEqual([
      { tag: "vendor/eu", provider: "Vendor", safetyRetention: true },
    ]);
  });

  it("fails clearly when the model has no eligible endpoint or the list cannot be read", async () => {
    await expect(plan([])).rejects.toMatchObject({ kind: "no-provider" });
    const broken = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(
      planRouting("vendor/model", "strict-zdr", {
        baseUrl: "https://example.invalid/api/v1",
        fetch: broken,
      }),
    ).rejects.toMatchObject({ kind: "network" });
  });
});

describe("SpendGuard", () => {
  it("reserves worst cases, settles actual costs, and refuses what would overspend", () => {
    const guard = new SpendGuard({ maxCostUsd: 1, maxRequests: 3 });
    const first = guard.reserve(0.6);
    expect(() => guard.reserve(0.5)).toThrow(/Budget/);
    guard.settle(first, 0.1);
    const second = guard.reserve(0.5);
    guard.settle(second, 0.2);
    expect(guard.spentUsd).toBeCloseTo(0.3, 10);
    expect(guard.reservedUsd).toBe(0);
    guard.reserve(0);
    expect(() => guard.reserve(0)).toThrow(/Request limit/);
  });
});

describe("Semaphore", () => {
  it("never runs more than its limit at once", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      semaphore.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 7 }, task));
    expect(peak).toBe(2);
  });

  it("frees its slot when a task fails", async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(semaphore.run(async () => "next")).resolves.toBe("next");
  });
});
