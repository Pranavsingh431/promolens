import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";

/** Checks what a stranger could fetch from a running build. */

async function scriptsOn(request: APIRequestContext, path: string): Promise<string[]> {
  const html = await (await request.get(path)).text();
  return [...new Set([...html.matchAll(/\/_next\/static\/[^"'\\]+\.js/g)].map((m) => m[0]))];
}

for (const path of [
  "/.env",
  "/private/ranking/ledger.json",
  "/private/reports/phase4-ranking.md",
  "/private/evaluation/sample.json",
  "/src/app/page.tsx",
]) {
  test(`does not serve ${path}`, async ({ request }) => {
    expect((await request.get(path)).status()).toBe(404);
  });
}

test("browser bundles hold no keys or private paths", async ({ request }) => {
  const scripts = [...(await scriptsOn(request, "/")), ...(await scriptsOn(request, "/demo"))];
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) {
    const body = await (await request.get(script)).text();
    expect(body).not.toMatch(/OPENROUTER_API_KEY|sk-or-v1|private\/ranking|private\/evaluation/);
  }
});

test("no browser chunk carries server code or secret values", () => {
  // Every file the browser could ever load, not only the ones two pages reference.
  const root = join(process.cwd(), ".next", "static");
  const files = (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
    .filter((name) => /\.(js|css)$/.test(name))
    .map((name) => join(root, name));
  expect(files.length).toBeGreaterThan(10);
  // Names that only server code uses. Their presence would mean server code was bundled.
  const serverCode =
    /OPENROUTER_API_KEY|DATABASE_URL|PROMOLENS_EDITORS|PROMOLENS_JOB_BUDGET_USD|issueSignedToken|handleUploadPresigned|SCRAM-SHA-256|PGlite|drizzle|WORKFLOW_TARGET_WORLD|__Host-promolens-session|yauzl/;
  // The shapes of real secrets: an OpenRouter key, a Blob read-write token,
  // a database URL with credentials, and an access-code hash.
  const secretValue =
    /sk-or-v1-[A-Za-z0-9]{8}|vercel_blob_rw_[A-Za-z0-9]|postgres(?:ql)?:\/\/[^"'\s]*@|scrypt\$\d+\$/;
  const leaks = files.flatMap((file) => {
    const body = readFileSync(file, "utf8");
    return [serverCode, secretValue].flatMap((rule) => {
      const match = rule.exec(body);
      return match ? [`${file.slice(root.length + 1)}: ${match[0].slice(0, 24)}`] : [];
    });
  });
  expect(leaks).toEqual([]);
});

test("the Workflow SDK publishes no manifest and no webhooks", async ({ request }) => {
  // The manifest lists workflow and step names; it is served only when built with
  // WORKFLOW_PUBLIC_MANIFEST=1. PromoLens creates no webhooks, so no token is valid.
  const base = "/.well-known/workflow/v1";
  expect((await request.get(`${base}/manifest.json`)).status()).toBe(404);
  expect((await request.get(`${base}/webhook/0123456789abcdef`)).status()).toBe(404);
  expect((await request.post(`${base}/webhook/0123456789abcdef`, { data: {} })).status()).toBe(404);
});

test("browser source maps are not published", async ({ request }) => {
  const [script] = await scriptsOn(request, "/");
  expect(script).toBeDefined();
  expect((await request.get(`${script}.map`)).status()).toBe(404);
});

test("the real workspace does not load the demo data", async ({ request }) => {
  const scripts = await scriptsOn(request, "/");
  for (const script of scripts) {
    const body = await (await request.get(script)).text();
    expect(body).not.toContain("Night Ferry");
    expect(body).not.toContain("CAPTAIN ODA");
  }
});

test("the page loads nothing from other sites", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname) && url.protocol.startsWith("http")) {
      external.push(url.hostname);
    }
  });
  await page.goto("/demo?pace=fast");
  await page.getByRole("button", { name: "Use the sample show" }).click();
  await page.getByRole("button", { name: "Find promos" }).click();
  await expect(page.getByRole("heading", { name: "Ranked promos" })).toBeVisible();
  expect(external).toEqual([]);
});
