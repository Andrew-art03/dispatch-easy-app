#!/usr/bin/env node
/**
 * TICKET 1F item 2 — the import-graph gate (ChatGPT panel finding C-1).
 *
 * THE FINDING. 1B's claimed invariant was "an agent process cannot hold a
 * production client". Every control built for it is a RUNTIME control:
 * `createDb()` refuses, `getEnv()` classifies, the kill switch trips. All of it
 * presupposes the agent goes through `createDb()`, and nothing made it. Two
 * client-construction paths exist in this repo, not one — `packages/config/db.ts`
 * (guarded) and `src/lib/supabase.ts` (Lovable's browser client, which builds a
 * client at import time from `import.meta.env`, before `createDb()` is anywhere
 * in the call stack to refuse it).
 *
 * `check:db-boundary` has flagged `src/lib/supabase.ts` since Sep 8 and it was
 * filed as lint debt. That framing was wrong: it is not a failing lint, it is
 * the invariant being false.
 *
 * WHAT THIS CHECK PROVES. Starting from every agent module, it walks the real
 * import graph — transitively, through re-exports — and fails if any reachable
 * module imports `@supabase/supabase-js`. That turns "the agent promises to call
 * the safe factory" into "there is no path by which the agent can construct a
 * client", which is what rule 40 asks for. A violation is reported as the whole
 * chain, entrypoint → … → offender, because the offender is rarely the file
 * anyone edited.
 *
 * WHY NOT A GREP. A grep for the package name misses
 * db-boundary:allow — the next line QUOTES an import to name the case; it is not one.
 * `export { createClient } from "@supabase/supabase-js"` re-exported one module
 * away, and misses `import { supabase } from "@/lib/supabase"` entirely — the
 * agent never names the package, it names a module that names it. Imports here
 * are extracted with TypeScript's own `preProcessFile`, the scanner the compiler
 * uses, and every specifier is resolved to a file and followed.
 *
 * LIMITS, stated rather than implied:
 *   - Third-party packages are leaves. We check the specifier against the
 *     forbidden list; we do not walk node_modules. A dependency that itself
 *     pulls in supabase-js would not be caught here (`check:bundle` is the rail
 *     that looks at what actually ships).
 *   - A computed specifier — `import("@supa" + "base/supabase-js")` — cannot be
 *     resolved statically by anything, this included. The eslint rails and
 *     `check:db-boundary` are the other layers.
 *   - Type-only imports count as edges. Deliberately strict: a module you can
 *     name types from is one edit away from a module you import.
 *
 * Fails closed: an unreadable file or an unresolvable relative specifier is an
 * error, not a pass.
 *
 * Usage:
 *   node scripts/assert-agent-imports.mjs              # gate the repo
 *   node scripts/assert-agent-imports.mjs --self-test  # prove it goes RED on a planted positive
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/** Modules under these roots are agent code: every one is a walk root. */
const AGENT_ROOTS = ["agents"];

/**
 * A path to any of these from agent code is a violation. The package is the
 * real rule — every in-repo client constructor imports it, so naming the
 * package catches `packages/config/db.ts`, `src/lib/supabase.ts` and anything
 * added later, with no list to keep up to date.
 */
const FORBIDDEN_PACKAGES = ["@supabase/supabase-js"];

/** Not walk roots: a test harness is not an agent process. */
const ROOT_EXCLUDE = /\.(test|spec)\.[cm]?[jt]sx?$/;

const SKIP_DIRS = new Set(["node_modules", ".git", ".output", "dist", ".tanstack", ".wrangler"]);
const SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const rel = (root, file) => relative(root, file).split(sep).join(posix.sep);

function walkDir(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkDir(full, out);
    else if (SOURCE_EXT.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

function isBare(specifier) {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

function forbiddenPackage(specifier) {
  return FORBIDDEN_PACKAGES.find((p) => specifier === p || specifier.startsWith(`${p}/`));
}

/**
 * Resolve a relative or `@/`-aliased specifier to a file on disk, the way the
 * bundler does. Returns null for a bare package specifier (a leaf) and throws
 * for a relative specifier that resolves to nothing — unresolvable is a defect
 * in the tree, not a pass.
 */
function resolveSpecifier(root, fromFile, specifier) {
  // Vite asset imports are not modules and never will be: `../styles.css?url`,
  // `./logo.svg`, `./data.json`. A `?query` suffix is a Vite-ism, and an
  // extension that is not a source extension means the thing on the other end
  // cannot import anything, so it is a leaf rather than an unresolvable defect.
  // Needed the moment `src/**` became a walk root at N-1 — the agent tree had
  // no assets in it, which is why this never came up before.
  const bare = specifier.split("?")[0];
  const ext = /\.[A-Za-z0-9]+$/.exec(bare)?.[0];
  if (ext !== undefined && !SOURCE_EXT.includes(ext)) return null;

  let base;
  if (specifier.startsWith("@/")) {
    base = resolve(root, "src", specifier.slice(2)); // tsconfig paths: "@/*" -> "./src/*"
  } else if (isBare(specifier)) {
    return null;
  } else {
    base = resolve(dirname(fromFile), specifier);
  }

  const candidates = [
    base,
    // ".ts" for a ".js" specifier: allowImportingTsExtensions is on, but a
    // module written for node resolution may still say ".js".
    ...(base.endsWith(".js") ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`] : []),
    ...SOURCE_EXT.map((e) => `${base}${e}`),
    ...SOURCE_EXT.map((e) => join(base, `index${e}`)),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* next candidate */
    }
  }
  throw new Error(`cannot resolve "${specifier}" from ${rel(root, fromFile)}`);
}

/** Every specifier this file imports, re-exports, or dynamically imports. */
function importsOf(file) {
  const text = readFileSync(file, "utf8");
  const pre = ts.preProcessFile(text, /* readImportFiles */ true, /* detectJavaScriptImports */ true);
  return pre.importedFiles.map((f) => f.fileName);
}

/**
 * Breadth-first walk from one root. Returns the first chain that reaches
 * something forbidden, or null. First and shortest, so the message names the
 * nearest cause rather than the deepest one.
 *
 * Two predicates, because the two directions forbid different kinds of thing.
 * `hitSpecifier` sees the raw specifier (that is how a bare package is caught —
 * a package resolves to nothing on disk). `hitFile` sees the repo-relative path
 * a specifier resolved to (that is how a MODULE is caught, whatever name was
 * used to reach it). Either returns the label to report, or null.
 */
function findForbiddenPath(root, entry, hitSpecifier, hitFile) {
  const queue = [[entry]];
  const seen = new Set([entry]);

  while (queue.length > 0) {
    const chain = queue.shift();
    const file = chain[chain.length - 1];

    for (const specifier of importsOf(file)) {
      const hit = hitSpecifier(specifier);
      if (hit) return { chain: chain.map((f) => rel(root, f)), specifier: hit };

      const resolved = resolveSpecifier(root, file, specifier);
      if (resolved === null) continue;

      const fileHit = hitFile(rel(root, resolved));
      if (fileHit) return { chain: chain.map((f) => rel(root, f)), specifier: fileHit };

      if (seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push([...chain, resolved]);
    }
  }
  return null;
}

const never = () => null;

/**
 * The whole gate as a function, so the self-test and the vitest suite can run
 * it against a fixture tree instead of only against this repo.
 */
export function checkAgentImports(root) {
  const entries = AGENT_ROOTS.flatMap((d) => walkDir(join(root, d))).filter(
    (f) => !ROOT_EXCLUDE.test(f),
  );
  const violations = [];
  for (const entry of entries) {
    const found = findForbiddenPath(root, entry, forbiddenPackage, never);
    if (found) violations.push(found);
  }
  return { entries: entries.map((f) => rel(root, f)), violations };
}

// ---------------------------------------------------------------------------
// The OTHER direction — 1F/N-1
// ---------------------------------------------------------------------------

/**
 * Roots that are NOT agent processes.
 *
 * `packages` is here and it is the reason this check exists. `packages/config/db.ts`
 * is the ONE sanctioned client factory; the app, the Edge Functions and
 * `scripts/migrate.ts` are all supposed to call it. It imported
 * `agents/secrets.ts` for the scrubber registry, `agents/secrets.ts` imports
 * `agents/agent-process.ts`, and that module runs `declareProcessKind("agent")`
 * at import time. So using the factory as designed declared the caller an agent
 * and then either killed it on its own `EZ_PROCESS_KIND=app` opt-out or refused
 * it the production client it was entitled to.
 *
 * `scripts` is deliberately NOT a root: a script run from `agents/` is an agent
 * by leg B anyway, and a maintenance script that wants agent identity may say so.
 */
const APP_ROOTS = ["src", "supabase/functions", "packages"];

/**
 * Modules whose mere import declares the process an agent. Reaching one of these
 * from an APP_ROOT is the N-1 defect.
 *
 * Matched as a resolved FILE, not as a specifier string, so it is caught however
 * it was named — `../../agents/agent-process.ts`, a re-export, an index barrel,
 * or a module that imports it three hops down and never mentions it.
 */
const AGENT_DECLARING_MODULES = ["agents/agent-process.ts"];

const declaringModule = (relPath) =>
  AGENT_DECLARING_MODULES.includes(relPath) ? relPath : null;

/**
 * Fails if app, edge or shared-config code can reach the agent declaration.
 *
 * `agents/agent-process.ts`'s own header claimed `check:agent-imports` already
 * did this. It did not — `AGENT_ROOTS = ["agents"]` and one forbidden package;
 * nothing looked this way at all, which is exactly how the N-1 edge survived a
 * panel, a CI run and four reviewers.
 */
export function checkAppImports(root) {
  const entries = APP_ROOTS.flatMap((d) => walkDir(join(root, d))).filter(
    (f) => !ROOT_EXCLUDE.test(f),
  );
  const violations = [];
  for (const entry of entries) {
    const found = findForbiddenPath(root, entry, never, declaringModule);
    if (found) violations.push(found);
  }
  return { entries: entries.map((f) => rel(root, f)), violations };
}

// ---------------------------------------------------------------------------
// Self-test — the planted positive, run every time the gate runs
// ---------------------------------------------------------------------------

/**
 * A gate nobody has seen fail is a gate nobody knows works. This builds the
 * exact positive the ticket names — a throwaway agent file importing
 * `src/lib/supabase.ts` — plus the harder one a grep would miss: the agent
 * naming neither the package nor the client module, reaching it two hops away
 * through a re-export.
 */
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "ez-agent-imports-"));
  try {
    const write = (p, body) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), body);
    };

    // db-boundary:allow — planted fixture, written to a temp dir and never to this tree.
    write("src/lib/supabase.ts", `import { createClient } from "@supabase/supabase-js";\nexport const supabase = createClient("u", "k");\n`);
    write("src/lib/reexport.ts", `export { supabase } from "./supabase.ts";\n`);
    write("agents/innocent.ts", `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`);

    const clean = checkAgentImports(dir);
    if (clean.violations.length !== 0) {
      console.error("SELF-TEST FAIL — a clean agent tree was reported as violating:");
      console.error(JSON.stringify(clean.violations, null, 2));
      process.exit(1);
    }

    // Positive 1: the ticket's own — an agent file importing src/lib/supabase.ts.
    write("agents/planted-direct.ts", `import { supabase } from "../src/lib/supabase.ts";\nexport const y = supabase;\n`);
    const direct = checkAgentImports(dir);

    // Positive 2: two hops, through a re-export, naming neither the package nor
    // the client module. This is the one a string grep cannot see.
    rmSync(join(dir, "agents/planted-direct.ts"));
    write("agents/planted-indirect.ts", `import { supabase } from "../src/lib/reexport.ts";\nexport const z = supabase;\n`);
    const indirect = checkAgentImports(dir);

    const ok =
      direct.violations.length === 1 &&
      direct.violations[0].chain.join(" -> ") ===
        "agents/planted-direct.ts -> src/lib/supabase.ts" &&
      indirect.violations.length === 1 &&
      indirect.violations[0].chain.join(" -> ") ===
        "agents/planted-indirect.ts -> src/lib/reexport.ts -> src/lib/supabase.ts";

    if (!ok) {
      console.error("SELF-TEST FAIL — the planted positives did not produce the expected chains.");
      console.error("  direct:  ", JSON.stringify(direct.violations));
      console.error("  indirect:", JSON.stringify(indirect.violations));
      process.exit(1);
    }
    // ---------------------------------------------------------------------
    // N-1: the direction rule, same treatment — a planted positive, seen RED
    // ---------------------------------------------------------------------
    rmSync(join(dir, "agents/planted-indirect.ts"));
    write("agents/agent-process.ts", `export const AGENT_PROCESS_DECLARED = true;\n`);
    write("packages/config/db.ts", `export const createDb = () => 1;\n`);

    const appClean = checkAppImports(dir);
    if (appClean.violations.length !== 0) {
      console.error("SELF-TEST FAIL — a clean app tree was reported as reaching the declaration:");
      console.error(JSON.stringify(appClean.violations, null, 2));
      process.exit(1);
    }

    // The N-1 shape exactly: the shared factory reaching the declaration two
    // hops away, through a module it imported for something else entirely.
    write("agents/secrets.ts", `import "./agent-process.ts";\nexport const registerSecretValue = () => undefined;\n`);
    write(
      "packages/config/db.ts",
      `import { registerSecretValue } from "../../agents/secrets.ts";\nexport const createDb = () => registerSecretValue();\n`,
    );
    const appPlanted = checkAppImports(dir);
    const appOk =
      appPlanted.violations.length === 1 &&
      appPlanted.violations[0].chain.join(" -> ") === "packages/config/db.ts -> agents/secrets.ts" &&
      appPlanted.violations[0].specifier === "agents/agent-process.ts";

    if (!appOk) {
      console.error("SELF-TEST FAIL — the planted direction positive did not produce the expected chain.");
      console.error("  app:", JSON.stringify(appPlanted.violations));
      process.exit(1);
    }

    console.log(
      "self-test: PASS — clean tree green; direct planted positive RED; " +
        "re-export planted positive RED with the full 3-file chain (a grep sees neither); " +
        "N-1 direction positive RED (packages/config/db.ts -> agents/secrets.ts -> the declaration).",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

const invokedPath = process.argv[1] ?? "";
const isMain =
  invokedPath.endsWith("assert-agent-imports.mjs") ||
  import.meta.url === new URL(`file://${invokedPath.replace(/\\/g, "/")}`).href;

if (isMain) {
  if (process.argv.includes("--self-test")) {
    selfTest();
    process.exit(0);
  }

  const root = fileURLToPath(new URL("..", import.meta.url));
  let result;
  let appResult;
  try {
    result = checkAgentImports(root);
    appResult = checkAppImports(root);
  } catch (error) {
    console.error(`check:agent-imports FAIL — the graph could not be walked: ${error.message}`);
    process.exit(2);
  }

  if (result.entries.length === 0) {
    console.error("check:agent-imports FAIL — no agent modules found. Fails closed rather than green.");
    process.exit(1);
  }

  if (appResult.entries.length === 0) {
    console.error(
      "check:agent-imports FAIL — no app/edge/shared modules found. Fails closed rather than green.",
    );
    process.exit(1);
  }

  if (result.violations.length > 0) {
    console.error("check:agent-imports FAIL — agent code can reach a Supabase client (rule 40):");
    for (const v of result.violations) {
      console.error(`  ${v.chain.join("\n    -> ")}\n    -> ${v.specifier}`);
    }
    console.error(
      "\nAn agent process must have NO import path to a client constructor. If an agent\n" +
        "genuinely needs data, it goes through an interface that does the fetching for it.\n",
    );
    process.exit(1);
  }

  if (appResult.violations.length > 0) {
    console.error("check:agent-imports FAIL — app/edge/shared code reaches the agent declaration (1F/N-1):");
    for (const v of appResult.violations) {
      console.error("  " + v.chain.join(" -> ") + " -> " + v.specifier);
    }
    console.error(
      [
        "",
        'Importing that module runs declareProcessKind("agent") for the whole process. An app',
        "process, an Edge Function or the shared client factory that reaches it becomes an agent",
        "by accident, and is then either killed by its own EZ_PROCESS_KIND=app opt-out or refused",
        "the production client it is entitled to. Move the shared thing out of agents/ instead.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  selfTest();
  console.log(
    `check:agent-imports OK — ${result.entries.length} agent modules walked, no path to ${FORBIDDEN_PACKAGES.join(", ")}; ` +
      `${appResult.entries.length} app/edge/shared modules walked, no path to ${AGENT_DECLARING_MODULES.join(", ")}.`,
  );
}
