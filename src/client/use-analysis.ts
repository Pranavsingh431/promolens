"use client";

import { useEffect, useState } from "react";

import { createAnalysisRunner, type AnalysisSession, type RunnerOptions } from "./analysis-runner";
import type { AnalysisService } from "./service";

export function useAnalysis(
  service: AnalysisService,
  options: RunnerOptions & { initialJobId?: string | undefined } = {},
) {
  const { initialJobId } = options;
  const [session, setSession] = useState<AnalysisSession>(
    initialJobId ? { phase: "opening" } : { phase: "idle" },
  );
  const [runner] = useState(() => createAnalysisRunner(service, setSession, options));
  useEffect(() => {
    if (initialJobId) runner.open(initialJobId);
    return () => runner.dispose();
  }, [runner, initialJobId]);
  return { session, ...runner };
}
