import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { promoExportSchema } from "../../src/domain/ranking/output";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function startDemo(page: Page, scenario = "complete") {
  await page.goto(`/demo?scenario=${scenario}&pace=fast`);
  await page.getByRole("button", { name: "Use the sample show" }).click();
  await page.getByRole("button", { name: "Analyze screenplays" }).click();
}

const card = (page: Page, rank: number) =>
  page.getByRole("button", { name: new RegExp(`Inspect recommendation ${rank}:`) });
const isWide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

async function openDetail(page: Page, rank: number) {
  await card(page, rank).click();
  const region = isWide(page)
    ? page.getByRole("complementary", { name: "Promo details" })
    : page.getByRole("dialog", { name: "Promo details" });
  await expect(region.getByRole("heading", { name: `Promo ${rank}` })).toBeVisible();
  return region;
}

test.describe("the real workspace", () => {
  test("keeps a chosen file local and says analysis is not connected", async ({ page }) => {
    const errors = collectErrors(page);
    const uploads: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") uploads.push(request.url());
    });
    await page.goto("/");
    await page.locator('input[type="file"]').setInputFiles({
      name: "show.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("not really a zip"),
    });
    await expect(page.getByText("show.zip")).toBeVisible();
    await page.getByRole("button", { name: "Analyze screenplays" }).click();
    await expect(
      page.getByRole("heading", { name: "Analysis is not connected yet" }),
    ).toBeVisible();
    await expect(page.getByText(/stayed on this computer/)).toBeVisible();
    await expect(page.getByText("show.zip", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ranked promos" })).toHaveCount(0);
    expect(uploads).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("refuses a file that is not a ZIP with a clear message", async ({ page }) => {
    await page.goto("/");
    await page.locator('input[type="file"]').setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello"),
    });
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "notes.txt is not a ZIP file",
    );
  });

  test("can be used by keyboard alone to choose and remove a file", async ({ page }) => {
    await page.goto("/");
    const input = page.locator('input[type="file"]');
    await input.focus();
    await expect(input).toBeFocused();
    await input.setInputFiles({
      name: "show.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("pk"),
    });
    await page.getByRole("button", { name: "Remove" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("show.zip")).toHaveCount(0);
    await expect(input).toBeFocused();
  });
});

test.describe("the labelled demo", () => {
  test("says on screen that it is made up", async ({ page }) => {
    await page.goto("/demo");
    await expect(page.getByText("A made-up show with made-up results.")).toBeVisible();
  });

  test("walks through the real stages to ranked results", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/demo?scenario=complete");
    await page.getByRole("button", { name: "Use the sample show" }).click();
    await page.getByRole("button", { name: "Analyze screenplays" }).click();
    await expect(page.getByRole("status").first()).toContainText(/Sending|Making sure|Reading/);
    await expect(page.locator('[aria-current="step"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ranked promos" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(card(page, 1)).toContainText("Episode 1 · 00:05.00 to 00:31.00");
    await expect(page.getByText("No person has rated them")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ranked promos" })).toBeFocused();
    expect(errors).toEqual([]);
  });

  test("can be cancelled while running", async ({ page }) => {
    await page.goto("/demo?scenario=complete");
    await page.getByRole("button", { name: "Use the sample show" }).click();
    await page.getByRole("button", { name: "Analyze screenplays" }).click();
    await page.getByRole("button", { name: "Cancel analysis" }).click();
    await expect(page.getByRole("heading", { name: "Analysis stopped" })).toBeVisible();
  });

  test("explains a failed analysis and offers a retry", async ({ page }) => {
    await startDemo(page, "failed");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("No episodes were found");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("marks a partial analysis honestly", async ({ page }) => {
    await startDemo(page, "partial");
    await expect(page.getByText("This analysis did not finish")).toBeVisible();
    await expect(page.getByText("Evaluation failed")).toBeVisible();
    await expect(page.getByText("AI provider declined to review")).toBeVisible();
  });

  test("explains when nothing passed", async ({ page }) => {
    await startDemo(page, "empty");
    await expect(page.getByRole("heading", { name: "No promos passed the checks" })).toBeVisible();
  });
});

test.describe("inspecting a promo", () => {
  test("shows evidence, the timeline, and multi-segment detail", async ({ page }) => {
    await startDemo(page);
    const detail = await openDetail(page, 2);
    await expect(
      detail.getByRole("region", { name: "Segment 1 of 2, episode 1", exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByRole("region", { name: "Segment 2 of 2, episode 3", exact: true }),
    ).toBeVisible();
    await expect(detail.getByRole("slider")).toHaveCount(2);
    await expect(detail.getByText("The hook", { exact: true })).toBeVisible();
    await expect(detail.locator('[data-evidence="hook"]').first()).toBeVisible();
  });

  test("links an evidence line to the timeline", async ({ page }) => {
    await startDemo(page);
    const detail = await openDetail(page, 1);
    await detail.getByRole("slider").waitFor();
    await detail
      .getByRole("list", { name: "Script lines behind the hook" })
      .getByRole("button")
      .first()
      .click();
    await expect(detail.locator('span[data-selected="true"]')).toHaveAttribute(
      "data-evidence",
      "hook",
    );
    await expect(detail.locator('li[aria-current="true"]')).toContainText(
      "My name was crossed out",
    );
  });

  test("steps through the timeline with the keyboard", async ({ page }) => {
    await startDemo(page);
    const detail = await openDetail(page, 1);
    const slider = detail.getByRole("slider");
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuenow", "2");
    await expect(detail.locator('li[aria-current="true"]')).toHaveCount(1);
  });

  test("shows boundary warnings on a rough cut", async ({ page }) => {
    await startDemo(page);
    const detail = await openDetail(page, 5);
    await expect(detail.getByText(/interrupts a spoken line at the start/)).toBeVisible();
    await expect(detail.getByText(/interrupts a spoken line at the end/)).toBeVisible();
  });

  test("shows a provider refusal without a score", async ({ page }) => {
    await startDemo(page);
    await page.getByRole("button", { name: /Inspect unevaluated moment/ }).click();
    const detail = isWide(page)
      ? page.getByRole("complementary", { name: "Promo details" })
      : page.getByRole("dialog", { name: "Promo details" });
    await expect(detail.getByRole("heading", { name: "Not evaluated" })).toBeVisible();
    await expect(detail.getByText(/That is not a rejection/)).toBeVisible();
    await expect(detail.getByText("Editorial score")).toHaveCount(0);
  });
});

test("wide screens show the list and the detail together", async ({ page }) => {
  test.skip(!isWide(page), "wide layout only");
  await startDemo(page);
  const panel = page.getByRole("complementary", { name: "Promo details" });
  await expect(panel.getByRole("heading", { name: "Promo 1" })).toBeVisible();
  await expect(card(page, 2)).toBeVisible();
  await card(page, 3).focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("heading", { name: "Promo 3" })).toBeFocused();
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(card(page, 3)).toBeFocused();
});

test("small screens use a full-screen view that Back and Escape close", async ({ page }) => {
  test.skip(isWide(page), "small layout only");
  await startDemo(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await card(page, 1).click();
  await expect(page.getByRole("dialog", { name: "Promo details" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Ranked promos" })).toBeVisible();
  await card(page, 2).click();
  await expect(page.getByRole("dialog", { name: "Promo details" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(card(page, 2)).toBeFocused();
});

test("exports match the rank-3 contract", async ({ page }) => {
  await startDemo(page);
  await expect(card(page, 1)).toBeVisible();
  const [json] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download JSON" }).click(),
  ]);
  expect(json.suggestedFilename()).toBe("promolens-demo-night-ferry-promos.json");
  const parsed = promoExportSchema.parse(JSON.parse(readFileSync(await json.path(), "utf8")));
  expect(parsed.promos).toHaveLength(7);
  expect(parsed.promos[1]?.promo.segments).toHaveLength(2);

  const [csv] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download CSV" }).click(),
  ]);
  const text = readFileSync(await csv.path(), "utf8");
  expect(text.trim().split("\r\n")).toHaveLength(8);
  expect(text).toContain("E001 00:05.00 to 00:31.00");
  await expect(page.getByText(/Saved promolens-demo-night-ferry-promos.csv/)).toBeVisible();
});

for (const width of [360, 768, 1024, 1440]) {
  test(`does not scroll sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await startDemo(page);
    await expect(card(page, 1)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("respects a reduced-motion preference", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/demo?scenario=complete");
  await page.getByRole("button", { name: "Use the sample show" }).click();
  await page.getByRole("button", { name: "Analyze screenplays" }).click();
  const animations = await page.evaluate(
    () => document.getAnimations().filter((a) => a.playState === "running").length,
  );
  expect(animations).toBe(0);
});
