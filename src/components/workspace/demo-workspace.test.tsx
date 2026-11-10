// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DemoScenario } from "@/demo/scenarios";

import { DemoWorkspace } from "./demo-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

beforeEach(() => {
  window.matchMedia = (() => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
});

async function runSample() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Use the sample show" }));
  await user.click(screen.getByRole("button", { name: "Find promos" }));
}

describe("the demo", () => {
  // Switching examples used to leave the workspace on the previous example's service, so
  // "Finished analysis" could fail with "No episodes were found" and the reverse.
  it.each<[DemoScenario, DemoScenario]>([
    ["failed", "complete"],
    ["complete", "failed"],
  ])(
    "runs the example on screen after switching from %s to %s",
    async (from, to) => {
      const { rerender } = render(<DemoWorkspace scenario={from} pace="fast" />);
      await screen.findByRole("button", { name: "Use the sample show" });
      rerender(<DemoWorkspace scenario={to} pace="fast" />);
      await runSample();
      if (to === "complete") {
        expect(
          await screen.findByRole("heading", { name: "Ranked promos" }, { timeout: 10_000 }),
        ).toBeTruthy();
        expect(screen.queryByText("No episodes were found")).toBeNull();
      } else {
        expect(
          await screen.findByText("No episodes were found", {}, { timeout: 10_000 }),
        ).toBeTruthy();
        expect(screen.queryByRole("heading", { name: "Ranked promos" })).toBeNull();
      }
    },
    20_000,
  );
});
