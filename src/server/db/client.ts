import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { schema } from "./schema.ts";

/**
 * One database interface over two drivers: node-postgres for a real server,
 * and PGlite (Postgres compiled to WebAssembly) for local work with nothing
 * to install. PGlite is reachable only through an explicit pglite: URL.
 */

export type Database = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

const MIGRATIONS = join(process.cwd(), "drizzle");

export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith("pglite:")) {
    const location = url.slice("pglite:".length);
    // Kept out of the bundle: PGlite is never used on a real deployment.
    if (location !== "memory") await mkdir(dirname(location), { recursive: true, mode: 0o700 });
    const { PGlite } = await import(/* turbopackIgnore: true */ "@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite(location === "memory" ? undefined : location);
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    return db as unknown as Database;
  }
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  // Small on purpose: each function instance holds few connections to a pooled endpoint.
  const pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 5_000 });
  return drizzle(pool, { schema }) as unknown as Database;
}
