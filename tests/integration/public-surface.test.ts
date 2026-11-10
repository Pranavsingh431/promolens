import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Checks what could reach a browser or a public repository. The names of real
 * shows and their lines must not appear in tracked files, so these tests look
 * for the shapes of a leak: unexpected public files, private paths, secrets,
 * trackers, and raw HTML injection.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function filesIn(dir: string): string[] {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .map((name) => join(absolute, name))
    .filter((path) => statSync(path).isFile());
}

const read = (path: string) => readFileSync(path, "utf8");
const sourceFiles = [...filesIn("src/client"), ...filesIn("src/components"), ...filesIn("src/demo")]
  .concat(filesIn("src/app"))
  .filter((path) => !/\.test\.tsx?$/.test(path) && /\.(ts|tsx)$/.test(path));

// Route handlers and the home page's server component run only on the server,
// so they alone may import server modules. Everything else here reaches browsers.
const isServerEntry = (path: string) =>
  /src\/app\/api\/.*\/route\.ts$/.test(path) || /src\/app\/page\.tsx$/.test(path);
const browserCode = sourceFiles.filter((path) => !isServerEntry(path));
const serverEntries = sourceFiles.filter(isServerEntry);

describe("what ships publicly", () => {
  it("has only the brand files in public/", () => {
    expect(
      filesIn("public")
        .map((path) => relative(ROOT, path))
        .sort(),
    ).toEqual([
      "public/brand/promolens-logo-dark.svg",
      "public/brand/promolens-logo.svg",
      "public/brand/promolens-mark.svg",
    ]);
  });

  it("keeps private inputs out of git and out of deployments", () => {
    for (const file of [".gitignore", ".vercelignore"]) {
      const rules = read(join(ROOT, file));
      for (const rule of ["/private/", "/*.zip", "/*.pdf", ".env"]) expect(rules).toContain(rule);
    }
  });

  it("does not publish browser source maps", () => {
    expect(read(join(ROOT, "next.config.ts"))).not.toMatch(/productionBrowserSourceMaps/);
  });

  it("has no analytics or session replay tools", () => {
    const manifest = read(join(ROOT, "package.json"));
    expect(manifest).not.toMatch(
      /posthog|sentry|hotjar|fullstory|logrocket|mixpanel|amplitude|segment-analytics|vercel\/analytics|vercel\/speed-insights|clarity/i,
    );
  });
});

describe("browser code", () => {
  it("was found", () => {
    expect(browserCode.length).toBeGreaterThan(20);
  });

  it.each(browserCode.map((path) => [relative(ROOT, path), path]))(
    "%s has no secrets, server imports, private paths, or raw HTML",
    (_name, path) => {
      const source = read(path as string);
      expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=/);
      expect(source).not.toMatch(/process\.env|OPENROUTER|sk-or-/);
      expect(source).not.toMatch(/from "@\/server|from "\.\.\/\.\.\/server|node:fs|yauzl/);
      expect(source).not.toMatch(/private\/(ranking|evaluation|reports)/);
    },
  );
});

describe("server entry points", () => {
  it("were found", () => {
    expect(serverEntries.length).toBeGreaterThan(10);
  });

  it.each(serverEntries.map((path) => [relative(ROOT, path), path]))(
    "%s is server only and holds no secrets or private paths",
    (_name, path) => {
      const source = read(path as string);
      expect(source).not.toMatch(/^["']use client["']/m);
      expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=/);
      expect(source).not.toMatch(/process\.env|OPENROUTER|sk-or-/);
      expect(source).not.toMatch(/private\/(ranking|evaluation|reports)/);
      if ((path as string).includes("/api/")) {
        expect(source).toContain('export const runtime = "nodejs"');
      }
    },
  );

  it("are never imported by browser code", () => {
    for (const path of browserCode) {
      expect(read(path)).not.toMatch(/from "@\/app\/(api|page)/);
    }
  });
});

describe("synthetic data", () => {
  it("uses only the made-up cast in the demo", () => {
    const show = read(join(ROOT, "src/demo/show.ts"));
    expect(show).toContain("made-up show");
    const speakers = new Set(
      [...show.matchAll(/"dialogue",[^\n]*"([A-Z ]+)"\],?$/gm)].map((m) => m[1]),
    );
    expect([...speakers].sort()).toEqual([
      "CAPTAIN ODA",
      "ENGINEER",
      "MARA",
      "OLD WOMAN",
      "THE PURSER",
    ]);
  });

  it("keeps no screenplay archives in tracked test data", () => {
    const fixtures = filesIn("tests").filter((path) => /\.(zip|pdf)$/i.test(path));
    expect(fixtures).toEqual([]);
  });
});

/**
 * Text rules above only see what a file imports directly, and only two spellings
 * of a server path. A browser bundle holds everything a client module reaches,
 * so this follows every static, re-exported, and dynamic import from each client
 * entry: every "use client" module, and everything under src/client,
 * src/components, and src/demo. Type-only imports are skipped because they are
 * erased before bundling. Nothing reached may live in src/server or
 * src/workflows, or load a package that only belongs on the server.
 */
describe("what a browser bundle can reach", () => {
  const SRC = join(ROOT, "src");
  const SERVER_PACKAGES = [
    /^pg($|\/)/,
    /^drizzle-orm($|\/)/,
    /^@electric-sql\/pglite($|\/)/,
    // The Blob server SDK can issue tokens and read or delete objects. Only its
    // /client entry, which uploads with a URL the server signed, may reach a browser.
    /^@vercel\/blob$/,
    /^workflow($|\/)/,
    /^yauzl$/,
    /^node:/,
    /^(fs|path|crypto|child_process|os|http|https|net|zlib|stream)$/,
  ];
  const IMPORT =
    /(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

  function resolveLocal(from: string, specifier: string): string | null {
    const base = specifier.startsWith("@/")
      ? join(SRC, specifier.slice(2))
      : join(from, "..", specifier);
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  }

  function importsOf(path: string): { local: string[]; packages: string[]; unresolved: string[] } {
    const local: string[] = [];
    const packages: string[] = [];
    const unresolved: string[] = [];
    for (const match of read(path).matchAll(IMPORT)) {
      const typeOnly = Boolean(match[1]);
      const specifier = match[2] ?? match[3];
      if (!specifier || typeOnly) continue;
      if (specifier.startsWith(".") || specifier.startsWith("@/")) {
        const resolved = resolveLocal(path, specifier);
        if (resolved) local.push(resolved);
        else if (!/\.(css|svg|png|json)$/.test(specifier)) unresolved.push(specifier);
      } else {
        packages.push(specifier);
      }
    }
    return { local, packages, unresolved };
  }

  const entries = [
    ...filesIn("src")
      .filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path))
      .filter((path) => /^["']use client["']/m.test(read(path))),
    ...browserCode.filter((path) => !/src\/app\//.test(path)),
  ];

  const reached = new Map<string, string>();
  const problems: string[] = [];
  const queue = [...new Set(entries)].map((path) => ({ path, via: relative(ROOT, path) }));
  while (queue.length) {
    const { path, via } = queue.shift() as { path: string; via: string };
    if (reached.has(path)) continue;
    reached.set(path, via);
    const name = relative(ROOT, path);
    if (/^src\/(server|workflows)\//.test(name))
      problems.push(`${via} reaches server code ${name}`);
    const { local, packages, unresolved } = importsOf(path);
    for (const specifier of unresolved) problems.push(`${name} imports unresolved ${specifier}`);
    for (const specifier of packages) {
      if (SERVER_PACKAGES.some((rule) => rule.test(specifier))) {
        problems.push(`${via} reaches server package ${specifier} through ${name}`);
      }
    }
    for (const next of local) queue.push({ path: next, via: `${via} > ${relative(ROOT, next)}` });
  }

  it("starts from the client entry points", () => {
    expect(entries.length).toBeGreaterThan(20);
    expect(entries.map((path) => relative(ROOT, path))).toContain("src/client/http-service.ts");
  });

  it("never reaches server modules or server-only packages", () => {
    expect(problems).toEqual([]);
    // Sanity: the walk really follows imports into shared domain code.
    expect([...reached.keys()].some((path) => /src\/domain\//.test(path))).toBe(true);
  });

  it("reads no server environment anywhere it reaches", () => {
    const readers = [...reached.keys()]
      .filter((path) => /process\.env\.(?!NODE_ENV\b)/.test(read(path)))
      .map((path) => relative(ROOT, path));
    expect(readers).toEqual([]);
  });

  it("would catch a leak through a path the text rules miss", () => {
    const sample = join(SRC, "client", "http-service.ts");
    const fake = `import { x } from "../server/db/client.ts";\nconst y = await import("pg");\n`;
    const matches = [...fake.matchAll(IMPORT)].map((m) => m[2] ?? m[3]);
    expect(matches).toEqual(["../server/db/client.ts", "pg"]);
    expect(resolveLocal(sample, "../server/db/client.ts")).toMatch(/src\/server\/db\/client\.ts$/);
    expect(SERVER_PACKAGES.some((rule) => rule.test("pg"))).toBe(true);
    expect(SERVER_PACKAGES.some((rule) => rule.test("@vercel/blob/client"))).toBe(false);
  });
});
