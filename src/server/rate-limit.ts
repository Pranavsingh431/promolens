import { sql } from "drizzle-orm";

import type { Database } from "./db/client.ts";
import { rateLimits } from "./db/schema.ts";

/**
 * Fixed-window counters in PostgreSQL. One atomic upsert per check, so parallel
 * requests on different instances still count against the same limit.
 */
export async function hitRateLimit(
  db: Database,
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowMs);
  const expired = sql`${rateLimits.windowStart} < ${cutoff.toISOString()}::timestamptz`;
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${expired} then 1 else ${rateLimits.count} + 1 end`,
        windowStart: sql`case when ${expired} then ${now.toISOString()}::timestamptz else ${rateLimits.windowStart} end`,
      },
    })
    .returning();
  const count = row?.count ?? 1;
  const started = row?.windowStart ?? now;
  return {
    allowed: count <= limit,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((started.getTime() + windowMs - now.getTime()) / 1000),
    ),
  };
}
