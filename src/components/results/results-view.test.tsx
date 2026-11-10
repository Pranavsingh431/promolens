// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { fakeService, job } from "../../../tests/support/analysis-service";
import { ServiceError, type AnalysisResults, type AnalysisService } from "@/client/service";
import { buildDemoResults } from "@/demo/results";
import type { DemoScenario } from "@/demo/scenarios";

import ResultsView from "./results-view";

function setWidth(wide: boolean) {
  window.matchMedia = (() => ({
    matches: wide,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
}

function show(
  options: {
    scenario?: DemoScenario;
    results?: AnalysisResults;
    wide?: boolean;
    service?: AnalysisService;
    onStartOver?: () => void;
  } = {},
) {
  setWidth(options.wide ?? true);
  const results = options.results ?? buildDemoResults(options.scenario ?? "complete");
  const service = options.service ?? fakeService([job("completed")]);
  return render(
    <ResultsView
      service={service}
      job={job("completed", { fileName: "night-ferry.zip" })}
      results={results}
      headingRef={createRef()}
      onStartOver={options.onStartOver ?? (() => {})}
    />,
  );
}

const card = (rank: number) =>
  screen.getByRole("button", { name: `View clip details for promo ${rank}` });
const cardOf = (rank: number) => card(rank).closest("article") as HTMLElement;
const detail = () => screen.findByRole("dialog", { name: "Promo details" });

/** Back closes the detail; jsdom does not fire popstate on its own. */
function mockBack() {
  return vi.spyOn(window.history, "back").mockImplementation(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

describe("ranked recommendations", () => {
  it("shows rank, episode, exact times, duration, hook, ending, reason, and score", () => {
    show();
    const first = cardOf(1);
    expect(first.textContent).toContain("Episode 1 · 00:05.00 to 00:31.00");
    expect(first.textContent).toContain("26.0 s");
    expect(first.textContent).toContain("My name was crossed out");
    expect(first.textContent).toContain("the cargo is gone");
    expect(first.textContent).toContain("catches the captain in a lie");
    expect(first.textContent).toContain("Editorial score 93.8");
    expect(within(first).getByText("93.8")).toBeTruthy();
    expect(within(first).getByRole("heading", { level: 3 }).textContent).toContain(
      "catches the captain in a lie",
    );
  });

  it("keeps each card to what an editor needs first", () => {
    show();
    const first = cardOf(1);
    // The full assessment waits in the detail view.
    expect(first.textContent).not.toContain("Would a new viewer follow it?");
    expect(first.textContent).not.toContain("of 4");
    expect(first.textContent).not.toMatch(/Excellent|Strong|Usable/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("never describes the score as a forecast, and says no person rated these", () => {
    const { container } = show();
    expect(container.textContent).not.toMatch(/viral|probability|chance of/i);
    expect(container.textContent).toContain("evaluated by AI");
    expect(container.textContent).toContain("No person has rated them");
    expect(container.textContent).toContain("does not predict views");
  });

  it("lists every segment of a multi-segment promo in order", () => {
    show();
    const multi = cardOf(2);
    expect(multi.textContent).toContain("Episode 1 · 00:49.50 to 01:02.40");
    expect(multi.textContent).toContain(", then Episode 3 · 00:49.40 to 01:01.00");
    expect(multi.textContent).toContain("2 segments · 24.5 s");
  });

  it("flags review and important warnings on the card, keeping minor ones for the detail", () => {
    show();
    expect(cardOf(4).textContent).toContain("Check before posting: Check clarity");
    expect(cardOf(4).textContent).not.toContain("Leans on earlier episodes");
    expect(cardOf(5).textContent).toContain("Cuts a line at the end");
    expect(cardOf(5).textContent).toContain("Cuts a line at the start");
    expect(cardOf(1).textContent).not.toContain("Check before posting");
  });

  it("shows alternatives on request and links a repeat to what it repeats", async () => {
    const user = userEvent.setup();
    show();
    expect(screen.queryByRole("button", { name: /for alternative/ })).toBeNull();
    const summary = screen.getByText("Alternatives (2)");
    await user.click(summary);
    (summary.closest("details") as HTMLDetailsElement).dispatchEvent(new Event("toggle"));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /for alternative/ })).toHaveLength(2),
    );
    expect(screen.getByText("Repeats recommendation 1")).toBeTruthy();
  });

  it("states provider refusals as refusals, with no score", () => {
    show();
    const section = screen.getByRole("region", { name: /Could not be evaluated/ });
    expect(section.textContent).toContain("AI provider declined to review");
    expect(section.textContent).toContain("Episode 3 · 00:00.00 to 00:24.00");
    expect(section.textContent).toContain("They were not rejected");
    expect(section.textContent).not.toContain("Editorial score");
  });

  it("marks a partial analysis and separates a failure from a refusal", () => {
    show({ scenario: "partial" });
    expect(screen.getByText("This analysis did not finish")).toBeTruthy();
    expect(screen.getByText("Evaluation failed")).toBeTruthy();
    expect(screen.getByText("AI provider declined to review")).toBeTruthy();
  });

  it("explains an empty result and offers the next step", async () => {
    const user = userEvent.setup();
    const onStartOver = vi.fn();
    show({ scenario: "empty", onStartOver });
    expect(screen.getByRole("heading", { name: "No promos passed the checks" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Analyze another file" }));
    expect(onStartOver).toHaveBeenCalled();
  });

  it("renders script and model text as text, never as markup", async () => {
    const results = buildDemoResults("complete");
    const attack = '<img src=x onerror="alert(1)">';
    const [first, ...rest] = results.ranking.shortlist;
    if (!first) throw new Error("fixture");
    const tampered = {
      ...results,
      ranking: {
        ...results.ranking,
        shortlist: [{ ...first, whyItWorks: attack }, ...rest],
      },
    };
    const { container } = show({ results: tampered });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(attack);
  });
});

describe("the detail view", () => {
  it("opens only when asked, on any screen size", async () => {
    for (const wide of [true, false]) {
      const { unmount } = show({ wide });
      expect(screen.queryByRole("dialog")).toBeNull();
      await userEvent.setup().click(card(1));
      const panel = await detail();
      expect((panel as HTMLDialogElement).open).toBe(true);
      expect(within(panel).getByRole("heading", { name: "Promo 1" })).toBeTruthy();
      unmount();
    }
  });

  it("moves focus into the detail on activation, and returns it to the card on close", async () => {
    const user = userEvent.setup();
    const back = mockBack();
    show();
    card(3).focus();
    await user.keyboard("{Enter}");
    const panel = await detail();
    const heading = within(panel).getByRole("heading", { name: "Promo 3" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await user.click(within(panel).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(back).toHaveBeenCalled();
    expect(document.activeElement).toBe(card(3));
    back.mockRestore();
  });

  it("steps to the next and previous promo, and closes on the one last shown", async () => {
    const user = userEvent.setup();
    const back = mockBack();
    show();
    await user.click(card(1));
    let panel = await detail();
    expect(
      (within(panel).getByRole("button", { name: "Previous promo" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(within(panel).getByRole("button", { name: "Next promo" }));
    panel = await detail();
    const heading = within(panel).getByRole("heading", { name: "Promo 2" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await user.click(within(panel).getByRole("button", { name: "Next promo" }));
    await user.click(within(await detail()).getByRole("button", { name: "Previous promo" }));
    expect(within(await detail()).getByRole("heading", { name: "Promo 2" })).toBeTruthy();
    // jsdom does not turn Escape into a dialog cancel; the browser tests cover Escape.
    await user.click(within(await detail()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(card(2));
    back.mockRestore();
  });

  it("puts what happens, the cut, the hook, and the ending before the scoring", async () => {
    const user = userEvent.setup();
    show();
    await user.click(card(1));
    const text = (await detail()).textContent ?? "";
    const order = ["What happens", "The cut", "The hook", "The ending", "In the script"].map(
      (label) => text.indexOf(label),
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.indexOf("Score and full assessment")).toBeGreaterThan(order[4] as number);
    expect(text).toContain("He finds her hiding on deck");
    // Scoring and provenance stay closed until asked for.
    const summaries = within(await detail()).getAllByText(
      /Score and full assessment|How this clip was found and ranked/,
    );
    for (const summary of summaries) {
      expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
    }
  });

  it("shows evidence, clarity, ratings, warnings, and each lowered rating's reason", async () => {
    const user = userEvent.setup();
    show();
    await user.click(card(4));
    const panel = await detail();
    const text = panel.textContent ?? "";
    expect(text).toContain("Check before posting");
    expect(text).toContain("The hook");
    expect(text).toContain("The ending");
    expect(text).toContain("Would a new viewer follow it?");
    expect(text).toContain("Partly clear");
    expect(text).toContain("How she and the captain know each other.");
    expect(text).toContain("Lowered from 3.");
    expect(text).toContain("only partly understands");
    expect(text).toContain("Leans on earlier episodes");
    expect(
      within(panel).getByRole("list", { name: "Script lines behind the hook" }).textContent,
    ).toContain("Where did you get that?");
  });

  it("lists every segment with its own duration", async () => {
    const user = userEvent.setup();
    show();
    await user.click(card(2));
    const table = within(await detail()).getByRole("table", {
      name: "Segments in the order they play",
    });
    const rows = within(table).getAllByRole("row");
    expect(rows[1]?.textContent).toBe("1100:49.5001:02.4012.9 s");
    expect(rows[2]?.textContent).toBe("2300:49.4001:01.0011.6 s");
  });

  it("loads each episode once, however often clips from it are opened", async () => {
    const user = userEvent.setup();
    const service = fakeService([job("completed")]);
    const getEpisode = vi.spyOn(service, "getEpisode");
    show({ service });
    await user.click(card(4));
    await within(await detail()).findByRole("slider");
    await user.click(within(await detail()).getByRole("button", { name: "Next promo" }));
    await within(await detail()).findByRole("slider");
    await user.click(within(await detail()).getByRole("button", { name: "Previous promo" }));
    await within(await detail()).findByRole("slider");
    const episodeTwo = getEpisode.mock.calls.filter(([, episode]) => episode === 2);
    expect(episodeTwo).toHaveLength(1);
  });

  it("keeps the explanation when the script fails to load, and can try again", async () => {
    const user = userEvent.setup();
    let healthy = false;
    const base = fakeService([job("completed")]);
    show({
      service: {
        ...base,
        getEpisode: (id, episode) =>
          healthy
            ? base.getEpisode(id, episode)
            : Promise.reject(new ServiceError("network", "Lost.", true)),
      },
    });
    await user.click(card(1));
    const panel = await detail();
    expect((await within(panel).findByRole("alert")).textContent).toContain(
      "The script could not be loaded",
    );
    expect(panel.textContent).toContain("The hook");
    healthy = true;
    await user.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(await within(panel).findByRole("slider")).toBeTruthy();
  });

  it("warns when a cited line does not match the script", async () => {
    const user = userEvent.setup();
    const results = buildDemoResults("complete");
    const [first, ...rest] = results.ranking.shortlist;
    const firstEvidence = first?.hook.evidence[0];
    if (!first || !firstEvidence) throw new Error("fixture");
    const tampered = {
      ...results,
      ranking: {
        ...results.ranking,
        shortlist: [
          {
            ...first,
            hook: {
              ...first.hook,
              evidence: [{ ...firstEvidence, text: "Words nobody wrote." }],
            },
          },
          ...rest,
        ],
      },
    };
    show({ results: tampered });
    await user.click(card(1));
    expect((await within(await detail()).findByRole("note")).textContent).toContain(
      "One cited line does not match the script",
    );
  });

  it("explains an unevaluated moment and still shows its script", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: /for unevaluated moment/ }));
    const panel = await detail();
    expect(within(panel).getByRole("heading", { name: "Not evaluated" })).toBeTruthy();
    expect(panel.textContent).toContain("That is not a rejection");
    expect(panel.textContent).not.toContain("Editorial score");
    expect(await within(panel).findByRole("slider")).toBeTruthy();
  });

  it("compares two promos side by side on request", async () => {
    const user = userEvent.setup();
    show();
    await user.click(card(1));
    const panel = await detail();
    await user.click(within(panel).getByText("Compare with another promo"));
    await user.selectOptions(
      within(panel).getByLabelText("Compare with"),
      "Promo 4: Episode 2, 00:06.20",
    );
    const table = within(panel).getByRole("table", { name: "Ratings for the two promos" });
    expect(table.textContent).toContain("93.8");
    expect(table.textContent).toContain("76.3");
  });
});

describe("export", () => {
  it("names what a download leaves out", () => {
    show();
    expect(screen.getByText(/1 moment could not be evaluated and is only listed/)).toBeTruthy();
  });

  it("downloads through the service and confirms it", async () => {
    const user = userEvent.setup();
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    show();
    await user.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(await screen.findByText("Saved promolens-demo-night-ferry-promos.csv.")).toBeTruthy();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it("offers the full report beside the other downloads", async () => {
    const user = userEvent.setup();
    const service = fakeService([job("completed")]);
    const exportResults = vi
      .spyOn(service, "exportResults")
      .mockRejectedValue(new ServiceError("unavailable", "No."));
    show({ service });
    await user.click(screen.getByRole("button", { name: "Download full report" }));
    expect(exportResults).toHaveBeenCalledWith(expect.any(String), "ranking-json");
  });

  it("says so when export is not available", async () => {
    const user = userEvent.setup();
    const base = fakeService([job("completed")]);
    show({
      service: {
        ...base,
        exportResults: () => Promise.reject(new ServiceError("unavailable", "No.")),
      },
    });
    await user.click(screen.getByRole("button", { name: "Download JSON" }));
    expect(await screen.findByText("Export is not connected in this build.")).toBeTruthy();
  });
});
