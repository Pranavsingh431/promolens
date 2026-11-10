/**
 * The order of work for one analysis. It only decides what runs next, so the
 * durable workflow and the tests share it. It must stay free of I/O, clocks,
 * and randomness, because a workflow replays this code.
 */

export type StepOutcome = { proceed: boolean };
export type PrepareOutcome = StepOutcome & { episodes: number[]; variants: string[] };
export type DiscoverOutcome = StepOutcome & { failedEpisodes: number[] };
export type RankOutcome = { next: "done" | "continue" | "wait" };

export type AnalysisOps = {
  prepare: () => Promise<PrepareOutcome>;
  discover: (variant: string, episodes: number[], readsDone: number) => Promise<DiscoverOutcome>;
  buildPool: () => Promise<StepOutcome>;
  rank: (slice: number, failureRounds: number) => Promise<RankOutcome>;
  fail: () => Promise<void>;
  /** Waits without holding a function open. */
  pause: (duration: "30s" | "2m") => Promise<void>;
};

/** Episodes per discovery step. Fewer, larger steps wait less on each step's slowest read. */
export const DISCOVERY_BATCH = 25;
/** Extra passes over episodes that failed for a reason a later try could fix. */
export const DISCOVERY_RETRY_PASSES = 2;
/** Far above any real show. A runaway loop stops here rather than spending forever. */
export const MAX_RANK_SLICES = 60;
export const MAX_FAILURE_ROUNDS = 2;

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function orchestrate(
  ops: AnalysisOps,
  options: { discoveryBatch?: number } = {},
): Promise<void> {
  const batchSize = options.discoveryBatch ?? DISCOVERY_BATCH;
  try {
    const prepared = await ops.prepare();
    if (!prepared.proceed) return;

    let reads = 0;
    let retry = new Map<string, number[]>();
    for (const variant of prepared.variants) {
      for (const batch of batches(prepared.episodes, batchSize)) {
        const result = await ops.discover(variant, batch, reads);
        if (!result.proceed) return;
        reads += batch.length - result.failedEpisodes.length;
        if (result.failedEpisodes.length) {
          retry.set(variant, [...(retry.get(variant) ?? []), ...result.failedEpisodes]);
        }
      }
    }
    for (let pass = 0; pass < DISCOVERY_RETRY_PASSES && retry.size > 0; pass++) {
      await ops.pause("30s");
      const next = new Map<string, number[]>();
      for (const [variant, episodes] of retry) {
        for (const batch of batches(episodes, batchSize)) {
          const result = await ops.discover(variant, batch, reads);
          if (!result.proceed) return;
          reads += batch.length - result.failedEpisodes.length;
          if (result.failedEpisodes.length) {
            next.set(variant, [...(next.get(variant) ?? []), ...result.failedEpisodes]);
          }
        }
      }
      retry = next;
    }

    const pool = await ops.buildPool();
    if (!pool.proceed) return;

    let failureRounds = 0;
    for (let slice = 0; slice < MAX_RANK_SLICES; slice++) {
      const result = await ops.rank(slice, failureRounds);
      if (result.next === "done") return;
      if (result.next === "wait") {
        failureRounds += 1;
        await ops.pause("2m");
      }
    }
    await ops.fail();
  } catch {
    await ops.fail();
  }
}
