// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { job } from "../../../tests/support/analysis-service";
import type { AnalysisService } from "@/client/service";
import type { JobSummary } from "@/domain/analysis-job";

import { AnalysisProgress, activeStage, progressLine, statusLine } from "./analysis-progress";
import { LiveWorkspace } from "./live-workspace";
import { RecentAnalyses } from "./recent-analyses";
import { SignIn } from "./sign-in";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

beforeEach(() => {
  window.matchMedia = (() => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  router.refresh.mockReset();
  router.replace.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const reply = (status: number, body: unknown = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("who sees what on the home page", () => {
  it("says so plainly when the deployment is not configured", () => {
    render(<LiveWorkspace access={{ kind: "unconfigured" }} />);
    expect(screen.getByText(/This preview cannot analyze screenplays yet/)).toBeTruthy();
  });

  it("does not blame the visitor when the service is down", () => {
    render(<LiveWorkspace access={{ kind: "unavailable" }} />);
    expect(screen.getByText(/temporarily unavailable/)).toBeTruthy();
  });

  it("offers a signed-out visitor only the sign-in form and the demo", () => {
    const { container } = render(<LiveWorkspace access={{ kind: "signed-out" }} />);
    expect(screen.getByRole("heading", { name: /Sign in to analyze/ })).toBeTruthy();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByRole("link", { name: /made-up show/ }).getAttribute("href")).toBe("/demo");
  });

  it("gives a signed-in editor the workspace and a way out", async () => {
    vi.stubGlobal("fetch", reply(200, { analyses: [] }));
    const { container } = render(<LiveWorkspace access={{ kind: "editor", name: "jamie" }} />);
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
    expect(screen.getByText("Signed in as jamie.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByText(/cannot analyze/)).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });
});

describe("the sign-in form", () => {
  async function submit(code = "the-access-code") {
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText("Editor name"), "jamie");
    await user.type(screen.getByLabelText("Access code"), code);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
  }

  it("hides what is typed and offers password managers the right fields", () => {
    render(<SignIn />);
    const code = screen.getByLabelText("Access code") as HTMLInputElement;
    expect(code.type).toBe("password");
    expect(code.autocomplete).toBe("current-password");
    expect((screen.getByLabelText("Editor name") as HTMLInputElement).autocomplete).toBe(
      "username",
    );
  });

  it("goes to the workspace after a right code", async () => {
    vi.stubGlobal("fetch", reply(200, { editor: "jamie" }));
    await submit();
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    const [, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ name: "jamie", code: "the-access-code" });
  });

  it.each([
    [401, "That name and access code do not match."],
    [429, "Too many attempts. Wait a few minutes."],
    [503, "Sign-in is not available right now. Try again in a few minutes."],
  ])("explains a %i", async (status, message) => {
    vi.stubGlobal("fetch", reply(status));
    await submit();
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("explains a lost connection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    await submit();
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not reach/);
  });
});

describe("earlier analyses", () => {
  const finished: JobSummary = {
    job: job("completed", { id: "a", fileName: "first.zip" }),
    showId: "show-a",
    createdAt: "2026-11-01T10:00:00.000Z",
    finishedAt: "2026-11-01T10:05:00.000Z",
  };
  const service = (items: JobSummary[], extra: Partial<AnalysisService> = {}) =>
    ({ listJobs: async () => items, deleteShow: async () => {}, ...extra }) as AnalysisService;

  it("shows nothing at all for a new editor", async () => {
    const { container } = render(<RecentAnalyses service={service([])} onOpen={() => {}} />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("opens one that is picked", async () => {
    const onOpen = vi.fn();
    render(<RecentAnalyses service={service([finished])} onOpen={onOpen} />);
    expect(await screen.findByText("first.zip")).toBeTruthy();
    expect(screen.getByText(/Ready/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("asks before deleting, and removes the row afterward", async () => {
    const deleteShow = vi.fn(async () => {});
    const user = userEvent.setup();
    render(<RecentAnalyses service={service([finished], { deleteShow })} onOpen={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(deleteShow).not.toHaveBeenCalled();
    expect(screen.getByText(/for good/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(deleteShow).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteShow).toHaveBeenCalledWith("show-a");
    await waitFor(() => expect(screen.queryByText("first.zip")).toBeNull());
  });

  it("says so when a delete fails, and keeps the row", async () => {
    const deleteShow = vi.fn(async () => {
      throw new Error("busy");
    });
    const user = userEvent.setup();
    render(<RecentAnalyses service={service([finished], { deleteShow })} onOpen={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/could not be deleted/)).toBeTruthy();
    expect(screen.getByText("first.zip")).toBeTruthy();
  });

  it("says so when the list cannot be loaded", async () => {
    const listJobs = async () => {
      throw new Error("down");
    };
    render(<RecentAnalyses service={service([], { listJobs })} onOpen={() => {}} />);
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
  });
});

describe("progress from the real service", () => {
  it("treats a queued job as about to check the file", () => {
    const queued = job("queued");
    expect(activeStage(queued)).toBe("validating");
    expect(statusLine(queued)).toMatch(/about to start/);
  });

  it("shows only counts the server reported", () => {
    expect(progressLine(job("discovering"))).toBeNull();
    expect(
      progressLine(
        job("discovering", { facts: { progress: { done: 3, total: 8, unit: "episodes" } } }),
      ),
    ).toBe("3 of 8 episodes searched");
    expect(
      progressLine(job("evaluating", { facts: { progress: { done: 12, unit: "moments" } } })),
    ).toBe("12 moments evaluated");
    expect(
      progressLine(job("ranking", { facts: { progress: { done: 40, unit: "comparisons" } } })),
    ).toBe("40 comparisons made");
  });

  it("shows planned totals once the server knows them", () => {
    const at = (done: number, total: number, unit: "screened" | "moments" | "comparisons") =>
      progressLine(job("evaluating", { facts: { progress: { done, total, unit } } }));
    expect(at(120, 250, "screened")).toBe("120 of 250 clips given a quick read");
    expect(at(37, 85, "moments")).toBe("37 of 85 planned detailed evaluations");
    expect(at(40, 96, "comparisons")).toBe("40 of 96 comparisons");
  });

  it("never shows a percentage", () => {
    const { container } = render(
      <AnalysisProgress
        job={job("ranking", {
          facts: { episodes: 8, moments: 40, progress: { done: 7, unit: "comparisons" } },
        })}
        upload={null}
      />,
    );
    expect(container.textContent).toContain("8 episodes read");
    expect(container.textContent).toContain("7 comparisons made");
    expect(container.textContent).not.toMatch(/%/);
  });
});
