import { expect, test, type Page } from "@playwright/test";

// The public demo: a made-up show, ranked in the browser. Five recommendations.
async function demoResults(page: Page) {
  await page.goto("/demo?scenario=complete&pace=fast");
  await page.getByRole("button", { name: "Use the sample show" }).click();
  await page.getByRole("button", { name: "Find 10 promos" }).click();
  await expect(page.getByRole("heading", { name: "Ranked promos" })).toBeVisible();
}

const shownRanks = (page: Page) =>
  page
    .getByRole("button", { name: /^View clip details for promo \d+$/ })
    .evaluateAll((buttons) =>
      buttons.map((b) => Number(/promo (\d+)/.exec(b.textContent ?? "")?.[1])),
    );

test("searches, filters, and sorts the ranked promos in the browser alone", async ({ page }) => {
  await demoResults(page);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (!request.url().includes("/_next/static/")) requests.push(request.url());
  });

  expect(await shownRanks(page)).toEqual([1, 2, 3, 4, 5]);

  await page.getByRole("searchbox", { name: "Search promos" }).fill("ep 3");
  await expect.poll(() => shownRanks(page)).toEqual([2, 3]);
  await expect(page.getByText("2 of 5 promos")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search promos" }).fill("");

  await page.getByRole("button", { name: "Filters" }).click();
  const panel = page.getByRole("dialog", { name: "Filters" });
  await expect(panel).toBeVisible();
  await panel.getByText("Multi-segment").click();
  await panel.getByRole("button", { name: "Show 1 promo" }).click();
  await expect(panel).toBeHidden();
  await expect.poll(() => shownRanks(page)).toEqual([2]);

  await page.getByRole("button", { name: "Remove filter: Multi-segment" }).click();
  await page.getByRole("combobox", { name: "Sort promos" }).selectOption("longest");
  await expect.poll(() => shownRanks(page)).toEqual([4, 3, 1, 2, 5]);

  await page.getByRole("searchbox", { name: "Search promos" }).fill("zzzz-nothing");
  await expect(page.getByRole("heading", { name: "No promos match" })).toBeVisible();
  await page.getByRole("button", { name: "Clear all" }).last().click();
  // Clearing keeps the chosen order, and every card keeps its own rank.
  await expect.poll(() => shownRanks(page)).toEqual([4, 3, 1, 2, 5]);

  expect(requests).toEqual([]);
});
