import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Applies the checked-in migrations. Run it yourself: nothing does this
 * automatically. Uses DATABASE_URL_UNPOOLED when set, like drizzle.config.ts,
 * because migrations are safer over a direct connection than through a pooler.
 */

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url || url.startsWith("pglite:")) {
  console.error("Set DATABASE_URL to a PostgreSQL database. PGlite migrates itself on start.");
  process.exit(1);
}
const pool = new Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
  console.log("Migrations are up to date.");
} finally {
  await pool.end();
}
