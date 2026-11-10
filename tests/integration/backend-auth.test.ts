import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolveAccess } from "../../src/server/access";
import { setBackendForTests } from "../../src/server/backend";
import { loadBackendConfig } from "../../src/server/config";
import { sessions } from "../../src/server/db/schema";
import { hitRateLimit } from "../../src/server/rate-limit";
import { CODES, call, createHarness, makeRequest, type Harness } from "../support/backend-harness";
import { routes, signIn, startJob, uploadShow } from "../support/backend-api";
import { buildUnseenShowZip } from "../support/unseen-show";

const FAKE_ID = "00000000-0000-4000-8000-000000000000";

const protectedCalls = [
  ["list analyses", () => call(routes.listAnalyses, "/api/analyses")],
  [
    "start analysis",
    () => call(routes.postAnalyses, "/api/analyses", { method: "POST", json: { showId: FAKE_ID } }),
  ],
  [
    "create upload",
    () =>
      call(routes.postUploads, "/api/uploads", {
        method: "POST",
        json: { fileName: "a.zip", sizeBytes: 10 },
      }),
  ],
  [
    "send content",
    () =>
      call(
        routes.putContent,
        `/api/uploads/${FAKE_ID}/content`,
        { method: "PUT", body: "x" },
        { id: FAKE_ID },
      ),
  ],
  [
    "complete upload",
    () =>
      call(
        routes.postComplete,
        `/api/uploads/${FAKE_ID}/complete`,
        { method: "POST" },
        { id: FAKE_ID },
      ),
  ],
  ["read job", () => call(routes.getAnalysis, `/api/analyses/${FAKE_ID}`, {}, { id: FAKE_ID })],
  [
    "cancel job",
    () =>
      call(
        routes.postCancel,
        `/api/analyses/${FAKE_ID}/cancel`,
        { method: "POST" },
        { id: FAKE_ID },
      ),
  ],
  [
    "retry job",
    () =>
      call(routes.postRetry, `/api/analyses/${FAKE_ID}/retry`, { method: "POST" }, { id: FAKE_ID }),
  ],
  [
    "read results",
    () => call(routes.getResults, `/api/analyses/${FAKE_ID}/results`, {}, { id: FAKE_ID }),
  ],
  [
    "export",
    () =>
      call(
        routes.getExport,
        `/api/analyses/${FAKE_ID}/export?format=promos-csv`,
        {},
        { id: FAKE_ID },
      ),
  ],
  [
    "read episode",
    () =>
      call(
        routes.getEpisode,
        `/api/analyses/${FAKE_ID}/episodes/1`,
        {},
        { id: FAKE_ID, number: "1" },
      ),
  ],
  [
    "delete show",
    () => call(routes.deleteShow, `/api/shows/${FAKE_ID}`, { method: "DELETE" }, { id: FAKE_ID }),
  ],
] as const;

describe("a deployment with missing credentials", () => {
  beforeAll(() => {
    setBackendForTests(null);
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("PROMOLENS_EDITORS", "");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it.each(protectedCalls)("refuses to %s", async (_name, send) => {
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "not-configured", message: "Analysis is not connected." },
    });
  });

  it("refuses sign-in and tells the home page it is unconfigured", async () => {
    const response = await call(routes.postSession, "/api/session", {
      method: "POST",
      json: { name: "alice", code: "anything-at-all" },
    });
    expect(response.status).toBe(503);
    expect(await resolveAccess(() => undefined)).toEqual({ kind: "unconfigured" });
  });

  it("names what is missing, and never accepts a partial setup", () => {
    const result = loadBackendConfig({ DATABASE_URL: "postgres://x" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.missing).toEqual(
      expect.arrayContaining(["PROMOLENS_EDITORS", "OPENROUTER_API_KEY", "PROMOLENS_STORAGE"]),
    );
  });

  it("needs the Blob webhook key, without which every presigned upload fails", () => {
    const blob = {
      DATABASE_URL: "postgres://x",
      PROMOLENS_EDITORS: "a:scrypt$1$1$1$a$b",
      OPENROUTER_API_KEY: "k",
      PROMOLENS_STORAGE: "vercel-blob",
      BLOB_STORE_ID: "store_test",
    };
    const without = loadBackendConfig(blob);
    expect(without.ok).toBe(false);
    expect(!without.ok && without.missing).toEqual(["BLOB_WEBHOOK_PUBLIC_KEY"]);
    const withKey = loadBackendConfig({ ...blob, BLOB_WEBHOOK_PUBLIC_KEY: "test-public-key" });
    expect(withKey.ok && withKey.config.storage).toEqual({ kind: "vercel-blob" });
  });

  it("refuses local-only settings on Vercel", () => {
    const local = {
      VERCEL: "1",
      DATABASE_URL: "pglite:memory",
      PROMOLENS_EDITORS: "a:scrypt$1$1$1$a$b",
      OPENROUTER_API_KEY: "k",
      PROMOLENS_STORAGE: "local",
      PROMOLENS_LOCAL_STORAGE_DIR: "/tmp/x",
    };
    const result = loadBackendConfig(local);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.missing.join(" ")).toMatch(/not pglite/);
    expect(!result.ok && result.missing.join(" ")).toMatch(/local is not allowed/);
  });
});

describe("signing in and staying signed in", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it.each(protectedCalls)("%s needs a session", async (_name, send) => {
    const response = await send();
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("gives a right code an HttpOnly, SameSite session cookie", async () => {
    const response = await call(routes.postSession, "/api/session", {
      method: "POST",
      json: { name: "alice", code: CODES.alice },
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(await response.text()).not.toContain(cookie.split("=")[1]?.split(";")[0]);
  });

  it("uses a Secure __Host- cookie everywhere except local storage", async () => {
    const { sessionCookie } = await import("../../src/server/http");
    const cloud = {
      ...h.config,
      storage: { kind: "vercel-blob" as const },
    };
    const value = sessionCookie(cloud, "token", new Date(0));
    expect(value.startsWith("__Host-promolens-session=")).toBe(true);
    expect(value).toMatch(/; Secure/);
    expect(value).not.toMatch(/Domain=/);
    expect(sessionCookie(h.config, "token", new Date(0))).not.toMatch(/Secure/);
  });

  it("refuses a wrong code and an unknown name with the same answer", async () => {
    const wrong = await call(routes.postSession, "/api/session", {
      method: "POST",
      json: { name: "alice", code: "wrong-wrong-wrong" },
    });
    const unknown = await call(routes.postSession, "/api/session", {
      method: "POST",
      json: { name: "nobody", code: "wrong-wrong-wrong" },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it("stores only a hash of the session token", async () => {
    const cookie = await signIn("alice");
    const token = cookie.split("=")[1] as string;
    const rows = await h.db.select().from(sessions);
    expect(rows.some((row) => row.tokenHash === token)).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("issues a new token at sign-in and revokes the one presented", async () => {
    const first = await signIn("alice");
    const second = await signIn("alice", first);
    expect(second).not.toBe(first);
    expect((await call(routes.listAnalyses, "/api/analyses", { cookie: first })).status).toBe(401);
    expect((await call(routes.listAnalyses, "/api/analyses", { cookie: second })).status).toBe(200);
  });

  it("stops honoring an expired session", async () => {
    const cookie = await signIn("bob");
    await h.db.update(sessions).set({ expiresAt: new Date(0) });
    expect((await call(routes.listAnalyses, "/api/analyses", { cookie })).status).toBe(401);
  });

  it("revokes the session at sign-out", async () => {
    const cookie = await signIn("alice");
    const out = await call(routes.deleteSession, "/api/session", { method: "DELETE", cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/Expires=Thu, 01 Jan 1970/);
    const token = cookie.split("=")[1] as string;
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(token).digest("hex");
    expect(await h.db.select().from(sessions).where(eq(sessions.tokenHash, hash))).toEqual([]);
    expect((await call(routes.listAnalyses, "/api/analyses", { cookie })).status).toBe(401);
  });

  it("the home page offers only what the session allows", async () => {
    const cookie = await signIn("alice");
    const token = cookie.split("=")[1];
    const signedIn = await resolveAccess(() => token);
    expect(signedIn).toMatchObject({ kind: "editor", editor: { name: "alice" } });
    expect(await resolveAccess(() => "not-a-real-token")).toEqual({ kind: "signed-out" });
    expect(await resolveAccess(() => undefined)).toEqual({ kind: "signed-out" });
  });
});

describe("requests from somewhere else", () => {
  let h: Harness;
  let cookie: string;
  beforeAll(async () => {
    h = await createHarness();
    cookie = await signIn("alice");
  });
  afterAll(() => h.close());

  const send = (headers: Record<string, string>) =>
    routes.postUploads(
      new Request("http://promolens.test/api/uploads", {
        method: "POST",
        headers: { cookie, "content-type": "application/json", ...headers },
        body: JSON.stringify({ fileName: "a.zip", sizeBytes: 10 }),
      }),
      { params: Promise.resolve({}) },
    );

  it("refuses a write with no Origin", async () => {
    expect((await send({ host: "promolens.test" })).status).toBe(403);
  });

  it("refuses a write from another site, with a valid session", async () => {
    const response = await send({ host: "promolens.test", origin: "https://evil.example" });
    expect(response.status).toBe(403);
  });

  it("refuses a browser-flagged cross-site write even if Origin looks right", async () => {
    const response = await send({
      host: "promolens.test",
      origin: "http://promolens.test",
      "sec-fetch-site": "cross-site",
    });
    expect(response.status).toBe(403);
  });

  it("allows the site's own pages", async () => {
    const response = await send({
      host: "promolens.test",
      origin: "http://promolens.test",
      "sec-fetch-site": "same-origin",
    });
    expect(response.status).toBe(201);
  });

  it("checks origin on sign-in too, before any password work", async () => {
    const request = makeRequest("/api/session", {
      method: "POST",
      json: { name: "alice", code: CODES.alice },
      headers: { origin: "https://evil.example" },
    });
    expect((await routes.postSession(request)).status).toBe(403);
  });
});

describe("rate limits", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("stops repeated sign-in attempts from one address, with Retry-After", async () => {
    const attempt = () =>
      call(routes.postSession, "/api/session", {
        method: "POST",
        json: { name: "alice", code: "wrong-wrong-wrong" },
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = await blocked.json();
    expect(body.error.code).toBe("rate-limited");
  });

  it("counts each editor separately", async () => {
    const window = 60_000;
    for (let i = 0; i < 3; i++) await hitRateLimit(h.db, "t:a", 3, window);
    expect((await hitRateLimit(h.db, "t:a", 3, window)).allowed).toBe(false);
    expect((await hitRateLimit(h.db, "t:b", 3, window)).allowed).toBe(true);
  });

  it("opens again once the window has passed", async () => {
    const window = 40;
    await hitRateLimit(h.db, "t:c", 1, window);
    expect((await hitRateLimit(h.db, "t:c", 1, window)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, window + 30));
    expect((await hitRateLimit(h.db, "t:c", 1, window)).allowed).toBe(true);
  });
});

describe("one editor's work is invisible to another", () => {
  let h: Harness;
  let alice: string;
  let bob: string;
  let job: string;
  let show: string;
  beforeAll(async () => {
    h = await createHarness();
    alice = await signIn("alice");
    bob = await signIn("bob");
    show = (await uploadShow(alice, buildUnseenShowZip(3))).showId;
    job = (await startJob(alice, show)).job.id;
  }, 60_000);
  afterAll(() => h.close());

  const reads: Array<[string, (cookie: string) => Promise<Response>]> = [
    ["status", (cookie) => call(routes.getAnalysis, `/x`, { cookie }, { id: job })],
    ["results", (cookie) => call(routes.getResults, `/x`, { cookie }, { id: job })],
    ["episode", (cookie) => call(routes.getEpisode, `/x`, { cookie }, { id: job, number: "1" })],
    ["export", (cookie) => call(routes.getExport, `/x?format=promos-csv`, { cookie }, { id: job })],
    ["cancel", (cookie) => call(routes.postCancel, `/x`, { method: "POST", cookie }, { id: job })],
    ["retry", (cookie) => call(routes.postRetry, `/x`, { method: "POST", cookie }, { id: job })],
    [
      "delete",
      (cookie) => call(routes.deleteShow, `/x`, { method: "DELETE", cookie }, { id: show }),
    ],
    [
      "start",
      (cookie) =>
        call(routes.postAnalyses, "/x", { method: "POST", cookie, json: { showId: show } }),
    ],
  ];

  it.each(reads)("%s answers exactly as if the thing did not exist", async (_name, request) => {
    const response = await request(bob);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not-found", message: "That was not found." },
    });
  });

  it("treats a malformed id like a missing one", async () => {
    const response = await call(
      routes.getAnalysis,
      "/x",
      { cookie: alice },
      { id: "../../etc/passwd" },
    );
    expect(response.status).toBe(404);
  });

  it("lists only the editor's own analyses", async () => {
    const own = await (await call(routes.listAnalyses, "/x", { cookie: alice })).json();
    const other = await (await call(routes.listAnalyses, "/x", { cookie: bob })).json();
    expect(own.analyses).toHaveLength(1);
    expect(other.analyses).toEqual([]);
  });

  it("keeps two editors' identical uploads separate", async () => {
    const bobs = await uploadShow(bob, buildUnseenShowZip(3));
    expect(bobs.duplicate).toBe(false);
    expect(bobs.showId).not.toBe(show);
  });

  it("marks private responses so no shared cache can keep them", async () => {
    const status = await call(routes.getAnalysis, "/x", { cookie: alice }, { id: job });
    expect(status.headers.get("cache-control")).toBe("private, no-store");
    const results = await call(routes.getResults, "/x", { cookie: alice }, { id: job });
    expect(results.headers.get("cache-control")).toBe("private, no-cache");
    expect(results.headers.get("vary")).toBe("Cookie");
    const exported = await call(
      routes.getExport,
      "/x?format=promos-json",
      { cookie: alice },
      { id: job },
    );
    expect(exported.headers.get("cache-control")).toBe("private, no-store");
  });
});
