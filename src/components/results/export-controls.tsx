"use client";

import { useState } from "react";

import { saveFile } from "@/client/export";
import { toServiceError, type AnalysisService, type ExportFormat } from "@/client/service";
import { Button } from "@/components/ui/button";

const OPTIONS: ReadonlyArray<{ format: ExportFormat; label: string }> = [
  { format: "promos-csv", label: "Download CSV" },
  { format: "promos-json", label: "Download JSON" },
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
    <div className="sm:text-right">
      <div className="flex flex-wrap gap-2 sm:justify-end">
        {OPTIONS.map(({ format, label }, index) => (
          <Button
            key={format}
            variant={index === 0 ? "primary" : "secondary"}
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
      {missingNote ? <p className="mt-1 max-w-sm text-xs text-ink-muted">{missingNote}</p> : null}
    </div>
  );
}
