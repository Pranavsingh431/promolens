// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { buildPromoTimeline } from "@/client/timeline-layout";
import { DEMO_SHOW } from "@/demo/show";

import { ScreenplayTimeline } from "./screenplay-timeline";

const timeline = buildPromoTimeline(DEMO_SHOW.episodes);
const HOOK_LINE = "E001-0005";
const ENDING_LINE = "E001-0017";
const ONE = [{ episode: 1, startMs: 5_000, endMs: 31_000 }];

function Harness({ segments = ONE }: { segments?: typeof ONE }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <ScreenplayTimeline
      timeline={timeline}
      segments={segments}
      hookIds={new Set([HOOK_LINE])}
      endingIds={new Set([ENDING_LINE])}
      selectedId={selected}
      onSelect={setSelected}
    />
  );
}

const row = (id: string) => document.querySelector(`li[data-event-id="${id}"]`) as HTMLElement;
const bar = (id: string) => document.querySelector(`span[data-event-id="${id}"]`) as HTMLElement;

describe("the screenplay timeline", () => {
  it("states the clip's exact position and each kind of event", () => {
    render(<Harness />);
    expect(screen.getAllByText("00:05.00 to 00:31.00").length).toBeGreaterThan(0);
    for (const label of ["Dialogue", "Action", "Sound", "Camera"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("shows source times exactly as written and scene headings", () => {
    render(<Harness />);
    expect(row(HOOK_LINE).textContent).toContain("00:05.20 to 00:08.40");
    expect(screen.getByText("Scene 1: EXT. FERRY DECK - NIGHT")).toBeTruthy();
    expect(screen.getAllByTestId("scene-boundary").length).toBeGreaterThan(0);
  });

  it("highlights hook and ending evidence in both the track and the list", () => {
    render(<Harness />);
    expect(bar(HOOK_LINE).dataset.evidence).toBe("hook");
    expect(bar(ENDING_LINE).dataset.evidence).toBe("ending");
    expect(row(HOOK_LINE).textContent).toContain("Hook");
    expect(row(ENDING_LINE).textContent).toContain("Ending");
  });

  it("selects an event by clicking its bar or its line, and shows it in both", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(bar(HOOK_LINE));
    expect(row(HOOK_LINE).getAttribute("aria-current")).toBe("true");
    expect(bar(HOOK_LINE).dataset.selected).toBe("true");
    await user.click(row(ENDING_LINE));
    expect(row(HOOK_LINE).getAttribute("aria-current")).toBeNull();
    expect(bar(ENDING_LINE).dataset.selected).toBe("true");
  });

  it("steps through events with the arrow keys and reads each one aloud", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const slider = screen.getByRole("slider");
    slider.focus();
    await user.keyboard("{ArrowRight}");
    expect(slider.getAttribute("aria-valuenow")).toBe("1");
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(slider.getAttribute("aria-valuenow")).toBe("3");
    expect(slider.getAttribute("aria-valuetext")).toMatch(/to .*\./);
    await user.keyboard("{End}");
    expect(slider.getAttribute("aria-valuenow")).toBe(slider.getAttribute("aria-valuemax"));
    await user.keyboard("{Home}");
    expect(slider.getAttribute("aria-valuenow")).toBe("1");
  });

  it("is one tab stop, not one per event", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("group", { name: "Timeline range" });
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("slider"));
    await user.tab();
    expect(document.activeElement).not.toBe(screen.getByRole("slider"));
    expect((document.activeElement as HTMLElement).tagName).toBe("INPUT");
  });

  it("lists only the clip by default, and the whole episode on request", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const outside = "E001-0001";
    expect(row(outside)).toBeNull();
    expect(bar(outside)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Whole episode" }));
    expect(screen.getByRole("button", { name: "Whole episode" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(row(outside)).not.toBeNull();
    expect(row(outside).textContent).toContain("Outside the clip");
  });

  it("filters the list by kind without touching the track", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const cameraRows = () =>
      [...document.querySelectorAll("li[data-event-id]")].filter(
        (li) => li.textContent?.startsWith("00:") && li.textContent.includes("Camera"),
      );
    expect(cameraRows().length).toBeGreaterThan(0);
    await user.click(screen.getByRole("checkbox", { name: "Camera" }));
    expect(cameraRows()).toHaveLength(0);
    expect(document.querySelectorAll("span[data-event-id]").length).toBeGreaterThan(0);
  });

  it("explains an empty filter", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    for (const name of ["Dialogue", "Action", "Sound", "Camera"]) {
      await user.click(screen.getByRole("checkbox", { name }));
    }
    expect(screen.getByText("Nothing to show with these filters.")).toBeTruthy();
  });

  it("warns about a spoken line cut at the clip's edge", () => {
    render(<Harness segments={[{ episode: 2, startMs: 43_000, endMs: 65_000 }]} />);
    expect(screen.getByText(/interrupts a spoken line at the start of the clip/)).toBeTruthy();
    expect(screen.getByText(/interrupts a spoken line at the end of the clip/)).toBeTruthy();
    expect(screen.getAllByTestId("cut-mark")).toHaveLength(2);
  });

  it("gives every segment its own timeline, labelled in order", () => {
    render(
      <Harness
        segments={[
          { episode: 1, startMs: 49_500, endMs: 62_400 },
          { episode: 3, startMs: 49_400, endMs: 61_000 },
        ]}
      />,
    );
    expect(screen.getByRole("region", { name: "Segment 1 of 2, episode 1" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Segment 2 of 2, episode 3" })).toBeTruthy();
    expect(screen.getAllByRole("slider")).toHaveLength(2);
  });

  it("ignores keys it does not use", () => {
    render(<Harness />);
    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: "a" });
    expect(slider.getAttribute("aria-valuenow")).toBe("1");
  });
});
