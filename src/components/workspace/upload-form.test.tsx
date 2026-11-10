// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { UploadForm } from "./upload-form";

const zip = (name = "show.zip", content = "pk") => new File([content], name);

function Harness({ onAnalyze = () => {} }: { onAnalyze?: (file: File) => void }) {
  const [file, setFile] = useState<File | null>(null);
  return <UploadForm file={file} onFileChange={setFile} onAnalyze={onAnalyze} />;
}

const picker = () => screen.getByLabelText(/Drop a ZIP/) as HTMLInputElement;

describe("the upload form", () => {
  it("shows the size limit and promises nothing is sent yet", () => {
    render(<Harness />);
    expect(screen.getByText(/up to 25 MB/)).toBeTruthy();
    expect(screen.getByText(/Nothing is uploaded until you press Analyze/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Analyze screenplays" })).toBeNull();
  });

  it("has one labelled, keyboard-reachable control for choosing a file", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    expect(document.activeElement).toBe(picker());
    expect(picker().getAttribute("aria-describedby")).toBeTruthy();
  });

  it("shows the chosen file and its size, and only sends it on Analyze", async () => {
    const user = userEvent.setup();
    const onAnalyze = vi.fn();
    render(<Harness onAnalyze={onAnalyze} />);
    await user.upload(picker(), zip("season-one.zip", "x".repeat(2048)));
    expect(screen.getByText("season-one.zip")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(onAnalyze).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Analyze screenplays" }));
    expect(onAnalyze).toHaveBeenCalledTimes(1);
  });

  it("explains a wrong file type, announces it, and links it to the control", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<Harness />);
    await user.upload(picker(), new File(["x"], "notes.pdf"));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("notes.pdf is not a ZIP file");
    expect(picker().getAttribute("aria-invalid")).toBe("true");
    expect(picker().getAttribute("aria-describedby")).toContain(alert.id);
  });

  it("replaces a file and clears an earlier error", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<Harness />);
    await user.upload(picker(), new File(["x"], "notes.pdf"));
    await user.upload(picker(), zip("first.zip"));
    expect(screen.queryByRole("alert")).toBeNull();
    const replace = screen.getByLabelText("Replace file");
    await user.upload(replace, zip("second.zip"));
    expect(screen.getByText("second.zip")).toBeTruthy();
    expect(screen.queryByText("first.zip")).toBeNull();
  });

  it("removes a file and returns focus to the picker", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.upload(picker(), zip());
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("show.zip")).toBeNull();
    expect(document.activeElement).toBe(picker());
  });

  it("accepts a dropped ZIP and refuses several files at once", () => {
    const { container } = render(<Harness />);
    const zone = container.firstElementChild as Element;
    fireEvent.drop(zone, { dataTransfer: { files: [zip("a.zip"), zip("b.zip")] } });
    expect(screen.getByRole("alert").textContent).toContain("one ZIP at a time");
    fireEvent.drop(zone, { dataTransfer: { files: [zip("dropped.zip")] } });
    expect(screen.getByText("dropped.zip")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a very long file name as text, without losing it", async () => {
    const user = userEvent.setup();
    const name = `${"long-name-".repeat(30)}.zip`;
    render(<Harness />);
    await user.upload(picker(), zip(name));
    expect(screen.getByText(name)).toBeTruthy();
  });
});
