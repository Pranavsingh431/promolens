import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    violations.map((v) => ({
      id: v.id,
      targets: v.nodes.map((n) => n.target.join(" ")).slice(0, 4),
      summary: v.nodes[0]?.failureSummary?.slice(0, 200),
    })),
  ).toEqual([]);
}

async function runDemo(page: Page, scenario: string) {
  await page.goto(`/demo?scenario=${scenario}&pace=fast`);
  await page.getByRole("button", { name: "Use the sample show" }).click();
  await page.getByRole("button", { name: "Analyze screenplays" }).click();
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test("upload screen", async ({ page }) => {
      await page.goto("/");
      await expectAccessible(page);
    });

    test("upload with an error", async ({ page }) => {
      await page.goto("/");
      await page.locator('input[type="file"]').setInputFiles({
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("hello"),
      });
      await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
      await expectAccessible(page);
    });

    test("analysis not connected", async ({ page }) => {
      await page.goto("/");
      await page.locator('input[type="file"]').setInputFiles({
        name: "show.zip",
        mimeType: "application/zip",
        buffer: Buffer.from("pk"),
      });
      await page.getByRole("button", { name: "Analyze screenplays" }).click();
      await expect(page.getByText("Analysis is not connected yet")).toBeVisible();
      await expectAccessible(page);
    });

    test("analysis in progress", async ({ page }) => {
      await page.goto("/demo?scenario=complete");
      await page.getByRole("button", { name: "Use the sample show" }).click();
      await page.getByRole("button", { name: "Analyze screenplays" }).click();
      await expect(page.locator('[aria-current="step"]')).toBeVisible();
      await expectAccessible(page);
    });

    test("ranked results with the detail open", async ({ page }) => {
      await runDemo(page, "complete");
      await page.getByRole("button", { name: /Inspect recommendation 5:/ }).click();
      await expect(page.getByRole("heading", { name: "Promo 5" })).toBeVisible();
      await expect(page.getByRole("slider").first()).toBeVisible();
      await expectAccessible(page);
    });

    test("partial results", async ({ page }) => {
      await runDemo(page, "partial");
      await expect(page.getByText("This analysis did not finish")).toBeVisible();
      await expectAccessible(page);
    });

    test("no promos", async ({ page }) => {
      await runDemo(page, "empty");
      await expect(
        page.getByRole("heading", { name: "No promos passed the checks" }),
      ).toBeVisible();
      await expectAccessible(page);
    });

    test("failed analysis", async ({ page }) => {
      await runDemo(page, "failed");
      await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
      await expectAccessible(page);
    });
  });
}
