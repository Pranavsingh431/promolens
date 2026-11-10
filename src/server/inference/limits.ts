import { InferenceError } from "./errors.ts";

/**
 * Hard limits for one run. Every HTTP attempt first reserves its worst-case
 * cost and one request slot. A reservation that would break a limit is
 * refused before anything is sent. After the response, the reservation is
 * replaced by what was actually spent.
 */
export class SpendGuard {
  maxCostUsd: number;
  maxRequests: number;
  requests = 0;
  spentUsd = 0;
  reservedUsd = 0;

  constructor(limits: { maxCostUsd: number; maxRequests: number }) {
    this.maxCostUsd = limits.maxCostUsd;
    this.maxRequests = limits.maxRequests;
  }

  reserve(worstCaseUsd: number): { amount: number } {
    if (this.requests >= this.maxRequests) {
      throw new InferenceError("request-limit", `Request limit of ${this.maxRequests} reached.`);
    }
    if (this.spentUsd + this.reservedUsd + worstCaseUsd > this.maxCostUsd) {
      throw new InferenceError(
        "budget",
        `Budget of $${this.maxCostUsd.toFixed(2)} would be exceeded (spent $${this.spentUsd.toFixed(4)}, reserved $${this.reservedUsd.toFixed(4)}, next call up to $${worstCaseUsd.toFixed(4)}).`,
      );
    }
    this.requests += 1;
    this.reservedUsd += worstCaseUsd;
    return { amount: worstCaseUsd };
  }

  settle(ticket: { amount: number }, actualUsd: number): void {
    this.reservedUsd = Math.max(0, this.reservedUsd - ticket.amount);
    this.spentUsd += actualUsd;
  }
}

/** Runs at most `limit` tasks at once. */
export class Semaphore {
  limit: number;
  active = 0;
  waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError("Concurrency must be at least 1");
    this.limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
