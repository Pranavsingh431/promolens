import { readFile } from "node:fs/promises";

import { z } from "zod";

import { writeJsonAtomic } from "../write-json-atomic.ts";

/**
 * Spending across every ranking run of one experiment, so the experiment
 * budget holds over many runs, not just within one. While a run is going,
 * its entry counts spent plus reserved money, an upper bound; when it ends,
 * the entry is replaced by what was actually spent. A run that crashed keeps
 * its upper bound, so the ledger never undercounts.
 */

export const ledgerSchema = z.object({
  experiment: z.string(),
  budgetUsd: z.number().positive(),
  runs: z.array(
    z.object({
      runId: z.string(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      spentUsd: z.number().nonnegative(),
      billedUsd: z.number().nonnegative().nullable(),
      requests: z.number().int().nonnegative(),
      status: z.enum(["running", "finished"]),
    }),
  ),
});
export type Ledger = z.infer<typeof ledgerSchema>;

export class LedgerError extends Error {}

export async function readLedger(
  path: string,
  defaults: { experiment: string; budgetUsd: number },
): Promise<Ledger> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { experiment: defaults.experiment, budgetUsd: defaults.budgetUsd, runs: [] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LedgerError(`${path} is damaged. Fix or remove it before spending more.`);
  }
  const parsed = ledgerSchema.safeParse(data);
  if (!parsed.success)
    throw new LedgerError(`${path} is damaged. Fix or remove it before spending more.`);
  return parsed.data;
}

export const spentSoFar = (ledger: Ledger) => ledger.runs.reduce((sum, r) => sum + r.spentUsd, 0);

export async function recordRun(
  path: string,
  ledger: Ledger,
  entry: Ledger["runs"][number],
): Promise<Ledger> {
  const next: Ledger = {
    ...ledger,
    runs: [...ledger.runs.filter((r) => r.runId !== entry.runId), entry],
  };
  await writeJsonAtomic(path, next);
  return next;
}
