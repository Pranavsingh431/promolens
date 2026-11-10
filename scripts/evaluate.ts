/**
 * Evaluation commands. Everything runs locally on the parsed pack. Nothing
 * calls a model, a database, or any network service.
 *
 * Usage: npm run eval -- <command> <pack.zip> [options]
 *
 *   sample          Choose evaluation episodes and the development/held-out split.
 *   candidates      Generate baseline candidates for every episode.
 *   prepare-review  Build blind Part B review items for the sampled episodes.
 *   validate        Check every annotation file.
 *   metrics         Compute metrics for a split and save them as JSON.
 *   report          Write a Markdown comparison report for a split.
 *
 * Options: --dir <path> (default private/evaluation), --split development|held-out|all,
 *          --k <n> (default 3), --list-k <n> (default 10), --per-method <n> (default 3), --force
 *
 * prepare-review also takes:
 *   --split <split>       episodes to build items for (default all)
 *   --controls <n>        per episode, lower-ranked clips from --control-set added as controls (default 0)
 *   --control-set <name>  method that supplies controls (default ranked)
 *   --append              keep existing items and ids, add only new clips
 *
 * Output stays in --dir, which must be git-ignored when it holds real screenplay data.
 */
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { validateAnnotations } from "../src/domain/evaluation/annotation.ts";
import { generateCueBased, generateUniform } from "../src/domain/evaluation/baselines.ts";
import { candidateSetSchema, type CandidateSet } from "../src/domain/evaluation/candidate.ts";
import { DEFAULT_METRIC_OPTIONS } from "../src/domain/evaluation/metrics.ts";
import { buildEvaluationReport, renderReportMarkdown } from "../src/domain/evaluation/report.ts";
import {
  prepareBlindReview,
  reviewItemsSchema,
  reviewKeySchema,
} from "../src/domain/evaluation/review.ts";
import { rankingOutputSchema } from "../src/domain/ranking/output.ts";
import {
  episodesInSplit,
  evaluationSampleSchema,
  selectSample,
  type Split,
} from "../src/domain/evaluation/sample.ts";
import { checkCandidateSet } from "../src/domain/evaluation/structural-checks.ts";
import {
  DEFAULT_EVALUATION_DIR,
  WorkspaceError,
  assertSamePack,
  loadPack,
  readAnnotationFiles,
  readJson,
  workspacePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/server/evaluation/workspace.ts";

const USAGE =
  "Usage: npm run eval -- <sample|candidates|prepare-review|validate|metrics|report> <pack.zip> [--dir path] [--split development|held-out|all] [--k n] [--list-k n] [--per-method n] [--controls n] [--control-set name] [--shortlist ranking.json] [--shortlist-controls n] [--append] [--force]";

const [command, packPath, ...rest] = process.argv.slice(2);
const flags = new Map<string, string | true>();
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i] ?? "";
  if (!arg.startsWith("--")) fail(USAGE, 2);
  const next = rest[i + 1];
  if (next !== undefined && !next.startsWith("--")) {
    flags.set(arg.slice(2), next);
    i++;
  } else {
    flags.set(arg.slice(2), true);
  }
}
const KNOWN = new Set([
  "dir",
  "split",
  "k",
  "list-k",
  "per-method",
  "controls",
  "control-set",
  "shortlist",
  "shortlist-controls",
  "append",
  "force",
]);
if (!command || !packPath || [...flags.keys()].some((f) => !KNOWN.has(f))) fail(USAGE, 2);

const dir = String(flags.get("dir") ?? DEFAULT_EVALUATION_DIR);
const paths = workspacePaths(dir);
const force = flags.get("force") === true;

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function positiveInt(name: string, fallback: number): number {
  const value = flags.get(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    fail(`--${name} must be a positive whole number.`, 2);
  return parsed;
}

function splitFlag(fallback: Split | "all" = "development"): Split | "all" {
  const value = flags.get("split") ?? fallback;
  if (value !== "development" && value !== "held-out" && value !== "all") {
    fail("--split must be development, held-out, or all.", 2);
  }
  return value;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function loadSets(packSha256: string): Promise<CandidateSet[]> {
  let names: string[] = [];
  try {
    names = (await readdir(paths.candidatesDir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    fail(`No candidates in ${paths.candidatesDir}. Run the candidates command first.`);
  }
  const sets = [];
  for (const name of names) {
    const set = await readJson(join(paths.candidatesDir, name), candidateSetSchema);
    assertSamePack(set.packSha256, packSha256, `Candidate file ${name}`);
    sets.push(set);
  }
  return sets;
}

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function main() {
  const pack = await loadPack(packPath as string);

  if (command === "sample") {
    if ((await exists(paths.sample)) && !force) {
      fail(
        `${paths.sample} already exists. The held-out set must stay fixed, so it is not replaced. Use --force only to start a new evaluation.`,
      );
    }
    const sample = selectSample(pack.show, pack.packSha256);
    await writeJsonAtomic(paths.sample, sample);
    console.log(
      `Sample ${sample.version} (seed ${sample.seed}): ${sample.episodes.length} of ${sample.episodeCount} episodes.\n`,
    );
    for (const e of sample.episodes) {
      console.log(
        `  E${String(e.episode).padStart(3, "0")}  ${e.split.padEnd(11)} ${e.length.padEnd(6)} ${e.position.padEnd(6)} ${e.reason.padEnd(30)} ${e.traits.join(", ")}`,
      );
    }
    console.log(
      `\nUncovered traits: ${sample.uncoveredTraits.join(", ") || "none"}. Saved to ${paths.sample}.`,
    );
    return;
  }

  if (command === "candidates") {
    const memoryBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const generations = [generateUniform(pack.timeline), generateCueBased(pack.timeline)];
    const elapsed = performance.now() - started;
    const heapMb = (process.memoryUsage().heapUsed - memoryBefore) / 1024 / 1024;

    for (const generation of generations) {
      const set = candidateSetSchema.parse({ ...generation, packSha256: pack.packSha256 });
      await writeJsonAtomic(paths.candidates(set.method), set);
      const check = checkCandidateSet(set, pack.timeline);
      const durations = set.candidates.map((c) => c.durationMs).sort((a, b) => a - b);
      const perEpisode = pack.show.episodes.map(
        (e) => set.candidates.filter((c) => c.segments[0]?.episode === e.number).length,
      );
      const validPerEpisode = pack.show.episodes.map(
        (e) =>
          set.candidates.filter(
            (c) =>
              c.segments[0]?.episode === e.number &&
              !(check.byCandidate.get(c.id) ?? []).some((i) => i.severity === "error"),
          ).length,
      );
      const sortedPer = [...perEpisode].sort((a, b) => a - b);
      console.log(`${set.method} (${set.methodVersion})`);
      console.log(
        `  Proposals ${set.proposals}, candidates ${set.candidates.length}, rejected ${JSON.stringify(set.rejected)}`,
      );
      console.log(
        `  Per episode: min ${sortedPer[0]}, median ${quantile(sortedPer, 0.5)}, max ${sortedPer.at(-1)}`,
      );
      console.log(
        `  Duration: min ${seconds(durations[0] ?? 0)}, p25 ${seconds(quantile(durations, 0.25))}, median ${seconds(quantile(durations, 0.5))}, p75 ${seconds(quantile(durations, 0.75))}, max ${seconds(durations.at(-1) ?? 0)}`,
      );
      console.log(
        `  Structurally valid ${check.valid}/${set.candidates.length}; with warnings ${check.withWarnings}`,
      );
      console.log(`  Issues ${JSON.stringify(check.counts)}`);
      console.log(
        `  Episodes with no valid candidate: ${
          pack.show.episodes
            .filter((_, i) => validPerEpisode[i] === 0)
            .map((e) => e.number)
            .join(", ") || "none"
        }`,
      );
      console.log(`  Saved to ${paths.candidates(set.method)}\n`);
    }
    console.log(
      `Generated both baselines in ${elapsed.toFixed(1)} ms; heap grew ${heapMb.toFixed(2)} MB; RSS ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB.`,
    );
    return;
  }

  const sample = await readJson(paths.sample, evaluationSampleSchema);
  assertSamePack(sample.packSha256, pack.packSha256, "The sample");

  if (command === "prepare-review") {
    const { files } = await readAnnotationFiles(dir);
    const append = flags.get("append") === true;
    const itemsExist = await exists(paths.reviewItems);
    if (itemsExist && files.some((f) => f.partB.length > 0) && !force && !append) {
      fail(
        "Part B ratings already exist for the current review items. Rebuilding would break them. Use --append to add new clips while keeping every existing item, or --force only for a new review round.",
      );
    }
    const split = splitFlag("all");
    if (split === "held-out") {
      console.warn(
        "Preparing held-out review items. Do this only after the ranking configuration is frozen.",
      );
    }
    const sets = await loadSets(pack.packSha256);
    const perMethod = positiveInt("per-method", 3);
    const controls = flags.has("controls") ? positiveInt("controls", 1) : 0;
    const controlSet = String(flags.get("control-set") ?? "ranked");
    if (controls && !sets.some((set) => set.method === controlSet)) {
      fail(`--controls needs the ${controlSet} candidate set in ${paths.candidatesDir}.`);
    }
    const existing =
      append && itemsExist
        ? {
            items: await readJson(paths.reviewItems, reviewItemsSchema),
            key: await readJson(paths.reviewKey, reviewKeySchema),
          }
        : undefined;
    const before = existing?.items.items.length ?? 0;
    let shortlist: { method: string; clipKeys: string[]; controlsPerEpisode: number } | undefined;
    if (flags.has("shortlist")) {
      if (!sets.some((set) => set.method === "ranked")) {
        fail(`--shortlist needs the ranked candidate set in ${paths.candidatesDir}.`);
      }
      const ranking = await readJson(String(flags.get("shortlist")), rankingOutputSchema);
      assertSamePack(ranking.packSha256, pack.packSha256, "The ranking");
      const heldOut = new Set(episodesInSplit(sample, "held-out"));
      const allowed = ranking.shortlist.filter((r) =>
        r.segments.every((s) => !heldOut.has(s.episode)),
      );
      if (allowed.length < ranking.shortlist.length) {
        console.warn(
          `Left out ${ranking.shortlist.length - allowed.length} recommendation(s) from held-out episodes.`,
        );
      }
      shortlist = {
        method: "ranked",
        clipKeys: allowed.map((r) => r.clipKey),
        controlsPerEpisode: positiveInt("shortlist-controls", 1),
      };
    }
    const { items, key } = prepareBlindReview(sets, episodesInSplit(sample, split), {
      perMethodPerEpisode: perMethod,
      seed: sample.seed + 1,
      sampleVersion: sample.version,
      ...(controls ? { controls: { method: controlSet, perEpisode: controls } } : {}),
      ...(shortlist ? { shortlist } : {}),
      ...(existing ? { existing } : {}),
    });
    await writeJsonAtomic(paths.reviewItems, items);
    await writeJsonAtomic(paths.reviewKey, key);
    const merged = key.entries.filter((e) => e.candidates.length > 1).length;
    const controlItems = key.entries.filter((e) =>
      e.candidates.every((c) => c.role === "control"),
    ).length;
    const shortlistItems = key.entries.filter((e) =>
      e.candidates.some((c) => c.role === "shortlist"),
    ).length;
    const shortlistControls = key.entries.filter((e) =>
      e.candidates.every((c) => c.role === "shortlist-control"),
    ).length;
    console.log(
      `Part A: ${episodesInSplit(sample, split).length} episodes to read in full (${split}).`,
    );
    console.log(
      `Part B: ${items.items.length} blind clips (${items.items.length - before} new) from ${sets.map((s) => s.method).join(", ")} ` +
        `(top ${perMethod} per method per episode, ${merged} proposed by more than one method, ${controlItems} lower-ranked controls${shortlist ? `, ${shortlistItems} final recommendations, ${shortlistControls} lower-ranked clips from their episodes` : ""}).`,
    );
    console.log(
      `Start the review tool with: npm run eval:review -- ${JSON.stringify(packPath)}${split === "all" ? "" : ` --split ${split}`}`,
    );
    return;
  }

  if (command === "validate") {
    const items = (await exists(paths.reviewItems))
      ? await readJson(paths.reviewItems, reviewItemsSchema)
      : { sampleVersion: sample.version, seed: 0, items: [] };
    const { files, problems } = await readAnnotationFiles(dir);
    let errors = 0;
    for (const problem of problems) {
      errors += problem.issues.length;
      console.log(`${problem.path}: unreadable`);
      for (const issue of problem.issues) console.log(`  error ${issue.path}: ${issue.message}`);
    }
    if (!files.length && !problems.length) {
      console.log("No annotation files yet. Human review has not started.");
      return;
    }
    for (const file of files) {
      const issues = validateAnnotations(file, { sample, timeline: pack.timeline, items });
      errors += issues.filter((i) => i.severity === "error").length;
      const complete = file.partA.filter((e) => e.status === "complete").length;
      const moments = file.partA.reduce((n, e) => n + e.moments.length, 0);
      console.log(
        `${file.reviewer}: Part A ${complete}/${sample.episodes.length} episodes complete, ${moments} moments; Part B ${file.partB.length}/${items.items.length} clips rated; revision ${file.revision}`,
      );
      for (const issue of issues)
        console.log(`  ${issue.severity} ${issue.path}: ${issue.message}`);
    }
    if (errors) fail(`${errors} error(s) found.`);
    console.log("All annotation files are valid.");
    return;
  }

  if (command === "metrics" || command === "report") {
    const split = splitFlag();
    if (split === "held-out") {
      console.warn(
        "Held-out evaluation. Use it for final checks only and do not tune methods on these results.",
      );
      await mkdir(paths.reportsDir, { recursive: true });
      await appendFile(paths.heldOutLog, `${new Date().toISOString()} ${command}\n`);
    }
    const sets = await loadSets(pack.packSha256);
    const items = (await exists(paths.reviewItems))
      ? await readJson(paths.reviewItems, reviewItemsSchema)
      : null;
    const { files, problems } = await readAnnotationFiles(dir);
    if (problems.length) fail("Some annotation files are invalid. Run the validate command first.");
    const key = items ? await readJson(paths.reviewKey, reviewKeySchema) : null;
    const report = buildEvaluationReport({
      sample,
      split,
      sets,
      timeline: pack.timeline,
      files,
      ...(key ? { reviewKey: key } : {}),
      options: {
        ...DEFAULT_METRIC_OPTIONS,
        k: positiveInt("k", DEFAULT_METRIC_OPTIONS.k),
        listK: positiveInt("list-k", DEFAULT_METRIC_OPTIONS.listK ?? 10),
      },
    });
    if (command === "metrics") {
      const path = join(paths.reportsDir, `metrics-${split}.json`);
      await writeJsonAtomic(path, report);
      console.log(`Annotation status: ${report.annotations.status}.`);
      for (const m of report.methods) {
        const e = m.editorial;
        const l = m.list;
        console.log(
          `  ${m.method}: valid ${m.structural.valid}/${m.structural.candidates}, coverage ${m.structural.episodesWithValid}/${m.structural.episodes}, ` +
            (e
              ? `P@${report.options.k} ${e.macro.precisionAtK.value?.toFixed(3) ?? "unavailable"}, nDCG@${report.options.k} ${e.macro.ndcgAtK.value?.toFixed(3) ?? "unavailable"}`
              : "editorial metrics unavailable") +
            (l
              ? `; list judged@${l.k} ${l.judgedAtK?.toFixed(2) ?? "unavailable"}, P@${l.k} judged-only ${l.precisionAtK?.toFixed(3) ?? "unavailable"}`
              : ""),
        );
      }
      console.log(`Saved to ${path}`);
    } else {
      const path = join(paths.reportsDir, `comparison-${split}.md`);
      await writeTextAtomic(path, renderReportMarkdown(report));
      console.log(`Saved to ${path}`);
    }
    return;
  }

  fail(USAGE, 2);
}

main().catch((error: unknown) => {
  if (error instanceof WorkspaceError) fail(error.message);
  throw error;
});
