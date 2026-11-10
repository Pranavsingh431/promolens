import { getBackend } from "../backend.ts";
import {
  buildPool,
  discoverBatch,
  failUnexpected,
  prepare,
  rankSlice,
  type PipelineDeps,
} from "./pipeline.ts";

/** The pipeline steps bound to this deployment's database, storage, and settings. */
export async function pipelineSteps() {
  const backend = await getBackend();
  if (!backend) throw new Error("The backend is not configured.");
  const deps: PipelineDeps = {
    db: backend.db,
    storage: backend.storage,
    config: backend.config,
    env: backend.env,
  };
  return {
    prepare: (jobId: string, runId: string) => prepare(deps, jobId, runId),
    discover: (
      jobId: string,
      runId: string,
      stepKey: string,
      variant: string,
      episodes: number[],
      readsDone: number,
    ) => discoverBatch(deps, jobId, runId, stepKey, variant, episodes, readsDone),
    buildPool: (jobId: string, runId: string) => buildPool(deps, jobId, runId),
    rank: (jobId: string, runId: string, stepKey: string, failureRounds: number) =>
      rankSlice(deps, jobId, runId, stepKey, failureRounds),
    fail: (jobId: string, runId: string) => failUnexpected(deps, jobId, runId),
  };
}
