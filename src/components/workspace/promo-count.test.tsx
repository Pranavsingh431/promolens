// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { WorkProfile } from "@/domain/estimate";
import { workProfile } from "@/server/analysis/calibration";
import type { BackendConfig } from "@/server/config";

import { PromoCount } from "./promo-count";

const PROFILE: WorkProfile = workProfile(
  {
    limits: {
      jobBudgetUsd: 1.5,
      rollingBudgetUsd: 15,
      jobMaxRequests: 6_000,
      modelConcurrency: 8,
      modelTimeoutMs: 120_000,
      modelAttempts: 3,
      stepBudgetMs: 200_000,
      retentionDays: 30,
    },
  } as BackendConfig,
  {},
);
const file = new File(["pk"], "show.zip");
const pack = async () => ({ episodes: 50, textKb: 516.6 });

function show(options: { profile?: WorkProfile | null; summary?: typeof pack } = {}) {
  const onFind = vi.fn();
  render(
    <PromoCount
      file={file}
      profile={options.profile === undefined ? PROFILE : options.profile}
      summarize={options.summary ?? pack}
      onFind={onFind}
    />,
  );
  return { onFind, user: userEvent.setup() };
}

const count = () => screen.getByLabelText("Number of promos") as HTMLInputElement;

describe("choosing how many promos to find", () => {
  it("starts at 10 and shows time and cost for this show before anything is sent", async () => {
    const { onFind, user } = show();
    expect(count().value).toBe("10");
    expect(await screen.findByText(/50 episodes\. Takes about \d+ to \d+ minutes\./)).toBeTruthy();
    expect(screen.getByText(/Estimated AI cost \$0\.\d\d to \$0\.\d\d/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Find 10 promos" }));
    expect(onFind).toHaveBeenCalledWith(10);
  });

  it("moves the estimate and the button with the number, from presets or typed", async () => {
    const { onFind, user } = show();
    const note = async () => (await screen.findByText(/Estimated AI cost/)).textContent ?? "";
    const atTen = await note();
    await user.click(screen.getByRole("button", { name: "5" }));
    expect(screen.getByRole("button", { name: "5" }).getAttribute("aria-pressed")).toBe("true");
    expect(await note()).not.toBe(atTen);
    await user.clear(count());
    await user.type(count(), "300");
    await user.click(screen.getByRole("button", { name: "Find 300 promos" }));
    expect(onFind).toHaveBeenCalledWith(300);
  });

  it("refuses counts that are not whole numbers from 1 to the ceiling", async () => {
    const { onFind, user } = show();
    for (const bad of ["0", "2.5", "501"]) {
      await user.clear(count());
      await user.type(count(), bad);
      expect(screen.getByText(/Choose a whole number from 1 to 500/)).toBeTruthy();
      const button = screen.getByRole("button", { name: /^Find/ }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    }
    expect(onFind).not.toHaveBeenCalled();
  });

  it("blocks a request that would go over the analysis budget, and says so", async () => {
    show({ profile: { ...PROFILE, budgetUsd: 0.05 } });
    expect(await screen.findByText(/more than the \$0\.05 limit/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Find 10 promos" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("says estimates are unavailable rather than inventing them", async () => {
    show({ profile: null });
    expect(screen.getByText(/not available for this setup/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Find 10 promos" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("waits for a readable ZIP before estimating", async () => {
    show({ summary: async () => null as never });
    await waitFor(() =>
      expect(screen.getByText(/appear once the file has been read/)).toBeTruthy(),
    );
  });
});
