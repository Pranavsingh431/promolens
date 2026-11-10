// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeService, job, zipFile } from "../../../tests/support/analysis-service";
import { ServiceError, type AnalysisService } from "@/client/service";
import { unavailableService } from "@/client/unavailable-service";

import { Workspace } from "./workspace";

beforeEach(() => {
  window.matchMedia = (() => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
});

async function analyze(service: AnalysisService) {
  const user = userEvent.setup();
  render(<Workspace service={service} />);
  await user.upload(screen.getByLabelText(/Drop your screenplay ZIP/), zipFile("show.zip"));
  await user.click(screen.getByRole("button", { name: "Find promos" }));
  return user;
}

describe("the workspace", () => {
  it("never pretends: without a backend it says so and keeps the file", async () => {
    await analyze(unavailableService);
    expect(
      await screen.findByRole("heading", { name: "Analysis is not connected yet" }),
    ).toBeTruthy();
    expect(screen.getByText(/show.zip stayed on this computer/)).toBeTruthy();
    expect(screen.getByText("show.zip")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Ranked promos" })).toBeNull();
  });

  it("announces the current stage in plain language, with no invented percentage", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const base = fakeService([job("discovering", { facts: { episodes: 12 }, canCancel: true })]);
    await analyze({
      ...base,
      getJob: async (id) => {
        await gate;
        return base.getJob(id);
      },
    });
    expect(await screen.findByRole("heading", { name: "Finding promos" })).toBeTruthy();
    expect(screen.getByText("show.zip")).toBeTruthy();
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Looking for promising moments in every episode.");
    expect(document.body.textContent).not.toMatch(/\d+\s*%/);
    expect(screen.getByText("12 episodes read")).toBeTruthy();
    const current = document.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain("Finding promising moments");
    expect(current?.textContent).toContain("In progress");
    release();
  });

  it("shows real upload progress only when the service reports it", async () => {
    await analyze(
      fakeService([job("uploading")], {
        startAnalysis: (_file, options) => {
          options.onUploadProgress?.({ loadedBytes: 1024, totalBytes: 2048 });
          return new Promise(() => {});
        },
      }),
    );
    expect(await screen.findByText("1.0 KB of 2.0 KB")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Upload progress" })).toBeTruthy();
  });

  it("moves focus to the results heading and shows ranked promos", async () => {
    await analyze(fakeService([job("completed")]));
    const heading = await screen.findByRole("heading", { name: "Ranked promos" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("offers Cancel only when the job can be cancelled, and reports the outcome", async () => {
    const user = await analyze(fakeService([job("parsing", { canCancel: true, pollAfterMs: 50 })]));
    await user.click(await screen.findByRole("button", { name: "Cancel analysis" }));
    expect(await screen.findByRole("heading", { name: "Analysis stopped" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start again" })).toBeTruthy();
  });

  it("hides Cancel when the backend does not support it", async () => {
    await analyze(fakeService([job("parsing", { canCancel: false, pollAfterMs: 50 })]));
    await screen.findByRole("status");
    expect(screen.queryByRole("button", { name: "Cancel analysis" })).toBeNull();
  });

  it("explains a failed analysis, marks the failed stage, and offers a real retry", async () => {
    const failed = job("failed", {
      failure: { code: "invalid-archive", stage: "validating", retryable: true },
    });
    const base = fakeService([failed]);
    const startSpy = vi.fn(base.startAnalysis);
    const user = await analyze({ ...base, startAnalysis: startSpy });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This ZIP could not be read");
    expect(screen.getByText("Reading episodes").closest("li")?.textContent).toContain("Failed");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("does not offer a retry that cannot help", async () => {
    await analyze(
      fakeService([
        job("failed", { failure: { code: "too-large", stage: "validating", retryable: false } }),
      ]),
    );
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Choose another file" })).toBeTruthy();
  });

  it("recovers from a network failure while loading results", async () => {
    let healthy = false;
    const base = fakeService([job("completed")]);
    const user = await analyze({
      ...base,
      getResults: (id) =>
        healthy ? base.getResults(id) : Promise.reject(new ServiceError("network", "Lost.", true)),
    });
    expect((await screen.findByRole("alert")).textContent).toContain("lost contact");
    healthy = true;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Ranked promos" })).toBeTruthy();
  });

  it("clears the file on Choose another file", async () => {
    const user = await analyze(
      fakeService([
        job("failed", { failure: { code: "no-episodes", stage: "parsing", retryable: false } }),
      ]),
    );
    await user.click(await screen.findByRole("button", { name: "Choose another file" }));
    await act(async () => {});
    expect(screen.queryByText("show.zip")).toBeNull();
    expect(screen.getByLabelText(/Drop your screenplay ZIP/)).toBeTruthy();
  });
});
