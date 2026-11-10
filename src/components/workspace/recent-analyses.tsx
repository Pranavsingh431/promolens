"use client";

import { useEffect, useState } from "react";

import type { JobState, JobSummary } from "@/domain/analysis-job";
import type { AnalysisService } from "@/client/service";
import { Button } from "@/components/ui/button";

const STATE_LABEL: Partial<Record<JobState, string>> = {
  completed: "Ready",
  partial: "Partly finished",
  failed: "Did not finish",
  cancelled: "Stopped",
};

/** The editor's earlier analyses. They persist, so nothing has to be run twice. */
export function RecentAnalyses({
  service,
  onOpen,
}: {
  service: AnalysisService;
  onOpen: (jobId: string) => void;
}) {
  const [items, setItems] = useState<JobSummary[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    service
      .listJobs?.({ signal: controller.signal })
      .then(setItems)
      .catch(() => {
        if (!controller.signal.aborted) setMessage("Your earlier analyses could not be loaded.");
      });
    return () => controller.abort();
  }, [service]);

  async function remove(showId: string) {
    setConfirming(null);
    try {
      await service.deleteShow?.(showId);
      setItems((current) => current?.filter((item) => item.showId !== showId) ?? null);
      setMessage("Deleted.");
    } catch {
      setMessage("That could not be deleted. If it is still running, stop it first.");
    }
  }

  if (!items?.length && !message) return null;
  return (
    <section className="mt-14" aria-labelledby="recent-heading">
      <h2 id="recent-heading" className="font-semibold">
        Earlier analyses
      </h2>
      <ul className="mt-3 divide-y divide-line border-y border-line">
        {items?.map(({ job, showId, createdAt }) => (
          <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <div className="min-w-0 flex-1 basis-48">
              <p className="font-medium [overflow-wrap:anywhere]">{job.fileName}</p>
              <p className="text-sm text-ink-muted">
                {STATE_LABEL[job.state] ?? "In progress"} ·{" "}
                {new Date(createdAt).toLocaleDateString()}
              </p>
            </div>
            {confirming === showId ? (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-danger">Delete this show and its results for good?</span>
                <Button variant="secondary" onClick={() => void remove(showId)}>
                  Delete
                </Button>
                <Button variant="quiet" onClick={() => setConfirming(null)}>
                  Keep
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <Button variant="secondary" onClick={() => onOpen(job.id)}>
                  Open
                </Button>
                <Button variant="quiet" onClick={() => setConfirming(showId)}>
                  Delete
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p role="status" className="mt-2 text-sm text-ink-muted">
        {message ?? ""}
      </p>
    </section>
  );
}
