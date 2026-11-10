import { expect, test, type Page } from "@playwright/test";

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("home page shows the workspace without pretending analysis exists", async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto("/");

  await expect(page).toHaveTitle("PromoLens");
  await expect(page.getByRole("link", { name: "PromoLens home" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Find the moments that make people stop scrolling.",
  );
  await expect(page.getByText("This preview cannot analyze screenplays yet.")).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Ranked promos" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("favicon is the brand mark", async ({ page, request }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(href).toBe("/brand/promolens-mark.svg");

  const response = await request.get(href ?? "");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("image/svg+xml");
});

test("page does not scroll sideways", async ({ page }) => {
  await page.goto("/");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("theme follows the system color scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  expect(light).toBe("rgb(250, 247, 242)");
  expect(dark).toBe("rgb(18, 16, 13)");
});

test("unknown routes return a branded 404", async ({ page }) => {
  const response = await page.goto("/does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
});
