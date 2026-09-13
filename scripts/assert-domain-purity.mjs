#!/usr/bin/env node
/**
 * `packages/domain/` is deterministic code with no runtime around it.
 *
 * SPEC-3B rule 5: the domain layer must never import `agents/`. The True-Net
 * calculator is the number a driver decides on, so it has to be reachable,
 * runnable and testable without the agent runtime anywhere near it — partly so
 * the money math stays deterministic (rule 2), and partly so nothing in the
 * domain layer can be made to depend on a model's output by accident.
 *
 * SPEC-4A acceptance 6 and 20 extend that, and item 20 is specific about the
 * standard: not a grep for a model SDK, but "a real walk" proving
 * `packages/domain/` has no DEPENDENCY PATH to `@supabase/supabase-js`, to a
 * client factory, or to an agent entrypoint — 1F's `check:agent-imports`
 * standard. A grep only sees the first hop; the thing you actually care about is
 * `normalizeLoad.ts -> helper.ts -> db.ts`, which no single-file grep catches.
 *
 * So this script does two passes:
 *
 *   PASS 1  the original line-level gate, kept as-is. It catches an import
 *           before the bundler or the type system has an opinion and keeps
 *           working for a dynamic `import()` or a `require`.
 *   PASS 2  a transitive module walk from every file in `packages/domain/`,
 *           following relative imports across the repo, and failing on any
 *           reachable module that is an agent entrypoint, a database client
 *           factory, a Supabase SDK or a model SDK — with the import chain that
 *           got there printed, because "you depend on the database" is not
 *           actionable and "A -> B -> C is" is.
 *
 * 4A is why the second pass matters now: `normalizeLoad` is a pure function that
 * turns attacker-controlled text into a typed object. `NormalizedLoad` is not a
 * row. If the module that builds it can reach a client factory at all, the next
 * edit is one line away from a document minting a tenant.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = "packages/domain";

/** Any syntax that could pull `agents/` into the domain layer. */
const FORBIDDEN = [
  /\bfrom\s+["'][^"']*\bagents\//,
  /\bimport\s*\(\s*["'][^"']*\bagents\//,
  /\brequire\s*\(\s*["'][^"']*\bagents\//,
];

/**
 * Bare specifiers the domain layer may never reach, at any depth.
 * `@supabase/supabase-js` is named by SPEC-4A; the model SDKs are acceptance 6.
 */
const FORBIDDEN_PACKAGES = [
  /^@supabase\//,
  /^@anthropic-ai\//,
  /^openai$/,
  /^@google\/generative-ai$/,
  /^@aws-sdk\/client-bedrock/,
  /^langchain/,
];

/** Repo paths that are an agent entrypoint or a database client factory. */
const FORBIDDEN_MODULES = [
  { match: /(?:^|[\\/])agents[\\/]/, why: "agent entrypoint" },
  { match: /packages[\\/]config[\\/]db\.ts$/, why: "database client factory" },
  { match: /[\\/]supabase(?:-client)?\.ts$/, why: "database client factory" },
];

const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory does not exist yet — nothing to police
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SOURCE.test(entry)) out.push(full);
  }
  return out;
}

/* ───────────────────────────── PASS 1 — line gate ──────────────────────────── */

const lineViolations = [];
for (const file of walk(ROOT)) {
  const source = readFileSync(file, "utf8");
  source.split(/\r?\n/).forEach((line, index) => {
    if (FORBIDDEN.some((pattern) => pattern.test(line))) {
      lineViolations.push(`  ${relative(".", file)}:${index + 1}  ${line.trim()}`);
    }
  });
}

/* ─────────────────────────── PASS 2 — dependency walk ──────────────────────── */

/** Every specifier this module imports, however it spells the import. */
function importSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** Resolve a relative specifier to a real file, trying the usual extensions. */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    base.replace(/\.js$/, ".ts"),
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

const graphViolations = [];
const visited = new Set();

function chainOf(trail) {
  return trail.map((file) => relative(".", file).split(sep).join("/")).join("\n       -> ");
}

function visit(file, trail) {
  if (visited.has(file)) return;
  visited.add(file);

  const relPath = relative(".", file);
  for (const rule of FORBIDDEN_MODULES) {
    if (rule.match.test(relPath) && trail.length > 1) {
      graphViolations.push(
        `  ${rule.why} reachable from packages/domain:\n       ${chainOf(trail)}`,
      );
      return;
    }
  }

  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return;
  }

  for (const specifier of importSpecifiers(source)) {
    if (specifier.startsWith(".")) {
      const next = resolveRelative(file, specifier);
      if (next !== undefined) visit(next, [...trail, next]);
      continue;
    }
    if (FORBIDDEN_PACKAGES.some((pattern) => pattern.test(specifier))) {
      graphViolations.push(
        `  "${specifier}" reachable from packages/domain:\n       ${chainOf(trail)}\n       -> ${specifier}`,
      );
    }
  }
}

// Absolute paths throughout, so a file reached through a relative import and the
// same file reached by the directory walk are one node in the graph, not two.
for (const entry of walk(ROOT)) {
  const absolute = resolve(entry);
  visit(absolute, [absolute]);
}

/* ─────────────────────────────────── report ────────────────────────────────── */

let failed = false;

if (lineViolations.length > 0) {
  failed = true;
  console.error("check:domain FAIL — packages/domain/ must not import agents/:");
  console.error(lineViolations.join("\n"));
  console.error(
    "\nThe domain layer is deterministic and must be reachable without the agent runtime (SPEC-3B rule 5).",
  );
}

if (graphViolations.length > 0) {
  failed = true;
  console.error("check:domain FAIL — packages/domain/ has a dependency path it must not have:");
  console.error(graphViolations.join("\n"));
  console.error(
    "\nSPEC-4A acceptance 20: packages/domain/ must have no path to @supabase/supabase-js,\n" +
      "a client factory, or an agent entrypoint. normalizeLoad() is a pure function and\n" +
      "NormalizedLoad is not a row — if the domain layer can reach a client at all, the next\n" +
      "edit is one line away from a document minting a tenant.",
  );
}

if (failed) process.exit(1);

console.log(
  `assert-domain-purity: OK — packages/domain/ imports no agent code, and no module reachable from it (${visited.size} walked) touches an agent entrypoint, a client factory, a Supabase SDK or a model SDK.`,
);
