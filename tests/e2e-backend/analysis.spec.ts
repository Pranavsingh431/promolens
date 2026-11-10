import { readFile } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { buildUnseenShowZip } from "../support/unseen-show";
import { APP_URL, EDITOR, MODEL_CONTROL, OTHER_EDITOR } from "./env";

const zipFile = (name: string, buffer: Buffer) => ({
  name,
  mimeType: "application/zip",
  buffer,
});

async function modelStats(page: Page) {
  const response = await page.request.get(`${MODEL_CONTROL}/stats`);
  return (await response.json()) as { chats: number; weakerRouting: number };
}

async function setModelMode(page: Page, mode: "healthy" | "auth-failure" | "hold-evaluation") {
  await page.request.post(`${MODEL_CONTROL}/mode`, { data: { mode } });
}

async function signIn(page: Page, who = EDITOR) {
  await page.goto("/");
  await page.getByLabel("Editor name").fill(who.name);
  await page.getByLabel("Access code").fill(who.code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${who.name}.`)).toBeVisible();
}

async function analyze(page: Page, name: string, buffer: Buffer) {
  await page.locator('input[type="file"]').setInputFiles(zipFile(name, buffer));
  await page.getByRole("button", { name: "Analyze screenplays" }).click();
}

const RESULTS = { name: "Ranked promos" };

test.describe.configure({ mode: "serial" });

test("a visitor must sign in, and a wrong code is refused", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to analyze screenplays" })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);

  await page.getByLabel("Editor name").fill(EDITOR.name);
  await page.getByLabel("Access code").fill("not-the-right-code");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That name and access code do not match.")).toBeVisible();
});

test("upload, analyze, follow progress, inspect, and export a show never seen before", async ({
  page,
}) => {
  await signIn(page);
  const before = await modelStats(page);
  await setModelMode(page, "hold-evaluation");
  await analyze(page, "salt-archive.zip", buildUnseenShowZip());

  // Real stages appear as the server reports them.
  await expect(page.getByRole("heading", { name: "Analyzing salt-archive.zip" })).toBeVisible();
  await expect(page.getByText(/5 episodes read/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/\d+ moments found/)).toBeVisible();
  await expect(page.locator('[aria-current="step"]')).toHaveText(/Evaluate moments/);

  // The analysis belongs to the server: a refresh mid-run returns to the same progress.
  await expect(page).toHaveURL(/\?job=[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.getByText(/5 episodes read/)).toBeVisible({ timeout: 15_000 });
  await setModelMode(page, "healthy");

  await expect(page.getByRole("heading", RESULTS)).toBeVisible({ timeout: 150_000 });
  await expect(page).toHaveURL(/\?job=[0-9a-f-]{36}$/);
  expect((await modelStats(page)).chats).toBeGreaterThan(before.chats);
  expect((await modelStats(page)).weakerRouting).toBe(0);

  // Inspect: the source events come from the uploaded screenplay, with its own timecodes.
  await page.getByRole("button", { name: /Inspect recommendation 1:/ }).click();
  const detail = page.getByRole("complementary", { name: "Promo details" });
  await expect(detail.getByRole("heading", { name: "Promo 1" })).toBeVisible();
  const lines = detail.getByRole("list", { name: "Script lines behind the hook" });
  await expect(lines.getByRole("button").first()).toBeVisible();
  await expect(detail.getByRole("slider").first()).toBeVisible();

  // Export: the real files, checked against what the server stored and the source text.
  const [csv] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download CSV" }).first().click(),
  ]);
  expect(csv.suggestedFilename()).toMatch(/promolens-.*-promos\.csv$/);
  const csvText = await readFile((await csv.path()) as string, "utf8");
  expect(csvText.split("\n").length).toBeGreaterThan(1);

  const id = new URL(page.url()).searchParams.get("job");
  const exported = await page.request.get(`/api/analyses/${id}/export?format=promos-json`);
  expect(exported.ok()).toBe(true);
  const { promos } = (await exported.json()) as {
    promos: Array<{ promo: { segments: Array<{ start: string; end: string }> } }>;
  };
  const source = buildUnseenShowZip().toString("utf8");
  const first = promos[0]?.promo.segments[0];
  expect(first).toBeDefined();
  // Exact timecodes: every cut point is written, digit for digit, in the source screenplay.
  expect(source).toContain(first?.start as string);
  expect(source).toContain(first?.end as string);

  // A refresh brings back the same stored result without any new model call.
  const settled = await modelStats(page);
  await page.reload();
  await expect(page.getByRole("heading", RESULTS)).toBeVisible();
  expect((await modelStats(page)).chats).toBe(settled.chats);
});

test("the same show again reuses the finished analysis and spends nothing", async ({ page }) => {
  await signIn(page);
  const before = await modelStats(page);
  await analyze(page, "renamed-copy.zip", buildUnseenShowZip());
  await expect(page.getByRole("heading", RESULTS)).toBeVisible({ timeout: 30_000 });
  expect((await modelStats(page)).chats).toBe(before.chats);
});

test("a damaged file gets a clear message and costs nothing", async ({ page }) => {
  await signIn(page);
  const before = await modelStats(page);
  await analyze(page, "broken.zip", Buffer.from("this is not a zip archive at all"));
  await expect(page.getByRole("heading", { name: "This file could not be used" })).toBeVisible();
  expect((await modelStats(page)).chats).toBe(before.chats);
});

test("a provider failure is reported honestly and a retry finishes the work", async ({ page }) => {
  await signIn(page);
  await setModelMode(page, "auth-failure");
  await analyze(page, "second-show.zip", buildUnseenShowZip(4, "the-glass-ferry"));
  await expect(page.getByText("The AI service is not responding").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("heading", RESULTS)).toHaveCount(0);

  await setModelMode(page, "healthy");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", RESULTS)).toBeVisible({ timeout: 150_000 });
});

test("another editor cannot see or touch this analysis", async ({ browser, page }) => {
  await signIn(page);
  const list = await (await page.request.get("/api/analyses")).json();
  const id = list.analyses[0].job.id as string;
  const showId = list.analyses[0].showId as string;

  const anonymous = await browser.newContext();
  expect((await anonymous.request.get(`/api/analyses/${id}/results`)).status()).toBe(401);
  await anonymous.close();

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await signIn(other, OTHER_EDITOR);
  for (const path of ["", "/results", "/episodes/1", "/export?format=promos-csv"]) {
    expect((await other.request.get(`/api/analyses/${id}${path}`)).status()).toBe(404);
  }
  await otherContext.close();

  // A write from another site is refused even with a valid session.
  const crossSite = await page.request.delete(`/api/shows/${showId}`, {
    headers: { origin: "https://elsewhere.example" },
  });
  expect(crossSite.status()).toBe(403);
});

test("the signed-in screens meet the accessibility checks", async ({ page, browser }) => {
  const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
  const check = async (target: Page) =>
    expect((await new AxeBuilder({ page: target }).withTags(tags).analyze()).violations).toEqual(
      [],
    );

  const context = await browser.newContext({ baseURL: APP_URL });
  const visitor = await context.newPage();
  await visitor.goto("/");
  await expect(visitor.getByRole("heading", { name: /Sign in to analyze/ })).toBeVisible();
  await check(visitor);
  await context.close();

  await signIn(page);
  await expect(page.getByRole("heading", { name: "Earlier analyses" })).toBeVisible();
  await check(page);

  await page.getByRole("button", { name: "Open" }).first().click();
  await expect(page.getByRole("heading", RESULTS)).toBeVisible();
  await check(page);
});

test("sign out ends access", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to analyze screenplays" })).toBeVisible();
  expect((await page.request.get("/api/analyses")).status()).toBe(401);
});
