/**
 * Starts the local review tool for human annotators.
 *
 * Usage: npm run eval:review -- <pack.zip> [--dir private/evaluation] [--port 4310] [--split development|held-out]
 *
 * Listens on 127.0.0.1 only. Annotations are saved under <dir>/annotations.
 * With --split, Part A shows only that split's episodes and Part B hides clips from the other
 * split. Final recommendations from unsampled episodes stay visible.
 */
import { itemVisible, reviewItemsSchema } from "../src/domain/evaluation/review.ts";
import { episodesInSplit, evaluationSampleSchema } from "../src/domain/evaluation/sample.ts";
import { createReviewServer } from "../src/server/evaluation/review-server.ts";
import {
  DEFAULT_EVALUATION_DIR,
  WorkspaceError,
  assertSamePack,
  loadPack,
  readJson,
  workspacePaths,
} from "../src/server/evaluation/workspace.ts";

const args = process.argv.slice(2);
const packPath = args[0];
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
if (!packPath || packPath.startsWith("--")) {
  console.error(
    "Usage: npm run eval:review -- <pack.zip> [--dir path] [--port 4310] [--split development|held-out]",
  );
  process.exit(2);
}
const dir = option("dir") ?? DEFAULT_EVALUATION_DIR;
const port = Number(option("port") ?? 4310);
const split = option("split");
if (split !== undefined && split !== "development" && split !== "held-out") {
  console.error("--split must be development or held-out.");
  process.exit(2);
}

try {
  const pack = await loadPack(packPath);
  const paths = workspacePaths(dir);
  const sample = await readJson(paths.sample, evaluationSampleSchema);
  assertSamePack(sample.packSha256, pack.packSha256, "The sample");
  const items = await readJson(paths.reviewItems, reviewItemsSchema);
  const only = split ? episodesInSplit(sample, split) : undefined;
  const server = createReviewServer({
    dir,
    timeline: pack.timeline,
    sample,
    items,
    ...(only ? { only } : {}),
  });
  const sampled = new Set(sample.episodes.map((e) => e.episode));
  const shownItems = items.items.filter((i) => itemVisible(i, sampled, only)).length;
  server.listen(port, "127.0.0.1", () => {
    console.log(`Review tool running at http://127.0.0.1:${port}  (Ctrl+C to stop)`);
    console.log(
      `${only?.length ?? sample.episodes.length} episodes for Part A, ${shownItems} clips for Part B${split ? ` (${split} only)` : ""}.`,
    );
  });
} catch (error) {
  if (error instanceof WorkspaceError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
