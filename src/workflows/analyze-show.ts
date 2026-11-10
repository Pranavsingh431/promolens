import { getStepMetadata, getWorkflowMetadata, sleep } from "workflow";

import { orchestrate } from "../server/analysis/orchestrate.ts";

/**
 * The durable analysis. Each step is a checkpoint: if a function dies or a
 * deployment changes, the run resumes after the last finished step. Only ids
 * cross step boundaries, so no screenplay text enters workflow state.
 *
 * Server code is imported inside each step because workflow bodies run in a
 * sandbox with no Node.js APIs.
 */

async function prepareStep(jobId: string, runId: string) {
  "use step";
  const { pipelineSteps } = await import("../server/analysis/runtime.ts");
  return (await pipelineSteps()).prepare(jobId, runId);
}

async function discoverStep(
  jobId: string,
  runId: string,
  variant: string,
  episodes: number[],
  readsDone: number,
) {
  "use step";
  const { stepId, attempt } = getStepMetadata();
  const { pipelineSteps } = await import("../server/analysis/runtime.ts");
  const steps = await pipelineSteps();
  return steps.discover(jobId, runId, `${stepId}:${attempt}`, variant, episodes, readsDone);
}

async function buildPoolStep(jobId: string, runId: string) {
  "use step";
  const { pipelineSteps } = await import("../server/analysis/runtime.ts");
  return (await pipelineSteps()).buildPool(jobId, runId);
}

async function rankStep(jobId: string, runId: string, _slice: number, failureRounds: number) {
  "use step";
  const { stepId, attempt } = getStepMetadata();
  const { pipelineSteps } = await import("../server/analysis/runtime.ts");
  return (await pipelineSteps()).rank(jobId, runId, `${stepId}:${attempt}`, failureRounds);
}

async function failStep(jobId: string, runId: string) {
  "use step";
  const { pipelineSteps } = await import("../server/analysis/runtime.ts");
  await (await pipelineSteps()).fail(jobId, runId);
}

export async function analyzeShow(jobId: string) {
  "use workflow";
  const { workflowRunId: runId } = getWorkflowMetadata();
  await orchestrate({
    prepare: () => prepareStep(jobId, runId),
    discover: (variant, episodes, readsDone) =>
      discoverStep(jobId, runId, variant, episodes, readsDone),
    buildPool: () => buildPoolStep(jobId, runId),
    rank: (slice, failureRounds) => rankStep(jobId, runId, slice, failureRounds),
    fail: () => failStep(jobId, runId),
    pause: (duration) => sleep(duration),
  });
}
