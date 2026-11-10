"use client";

import { useState } from "react";

import { saveFile } from "@/client/export";
import { toServiceError, type AnalysisService, type ExportFormat } from "@/client/service";
import { Button } from "@/components/ui/button";

const OPTIONS: ReadonlyArray<{ format: ExportFormat; label: string; name: string }> = [
  { format: "promos-csv", label: "CSV", name: "Download CSV" },
  { format: "promos-json", label: "JSON", name: "Download JSON" },
  { format: "ranking-json", label: "Full report", name: "Download full report" },
];

export function useExport(service: AnalysisService, jobId: string) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [status, setStatus] = useState<{ message: string; failed: boolean } | null>(null);

  async function download(format: ExportFormat) {
    setBusy(format);
    setStatus(null);
    try {
      const file = await service.exportResults(jobId, format);
      saveFile(file);
      setStatus({ message: `Saved ${file.fileName}.`, failed: false });
    } catch (error) {
      setStatus({
        message:
          toServiceError(error).kind === "unavailable"
            ? "Export is not connected in this build."
            : "That file could not be created. Try again.",
        failed: true,
      });
    } finally {
      setBusy(null);
    }
  }

  return { busy, status, download };
}

/** Downloads are a secondary step, so they sit as quiet links rather than big buttons. */
export function ExportControls({
  service,
  jobId,
  missingNote,
}: {
  service: AnalysisService;
  jobId: string;
  /** Says what a download leaves out, when anything is left out. */
  missingNote: string | null;
}) {
  const { busy, status, download } = useExport(service, jobId);
  return (
    <div className="text-sm sm:text-right">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:justify-end">
        <span className="text-ink-muted">Download</span>
        {OPTIONS.map(({ format, label, name }) => (
          <Button
            key={format}
            variant="quiet"
            aria-label={name}
            disabled={busy !== null}
            onClick={() => void download(format)}
          >
            {label}
          </Button>
        ))}
      </div>
      <p
        role="status"
        className={status?.failed ? "mt-1 text-xs text-danger" : "mt-1 text-xs text-ink-muted"}
      >
        {status?.message ?? ""}
      </p>
      {missingNote ? <p className="mt-1 max-w-xs text-xs text-ink-muted">{missingNote}</p> : null}
    </div>
  );
}
