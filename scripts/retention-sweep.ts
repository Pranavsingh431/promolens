import { getBackend } from "../src/server/backend.ts";
import { sweepExpired } from "../src/server/retention.ts";

/**
 * Lists what has passed its retention date. It removes nothing unless --apply
 * is given, and it never touches a show with a job still running.
 *
 *   npm run retention:sweep
 *   npm run retention:sweep -- --apply
 */

const apply = process.argv.includes("--apply");
const backend = await getBackend();
if (!backend) {
  console.error("The backend is not fully configured, so nothing was checked.");
  process.exit(1);
}
const result = await sweepExpired(backend, { apply, now: new Date() });
console.log(
  `${apply ? "Removed" : "Would remove"} ${result.shows} show(s) and ${result.uploads} unfinished upload(s). ` +
    `${result.skippedBusy} show(s) were left alone because a job is running.`,
);
if (!apply) console.log("Nothing was changed. Add --apply to remove them.");
process.exit(0);
