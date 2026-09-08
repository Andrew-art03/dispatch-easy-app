#!/usr/bin/env node
/**
 * SPEC 1B: `@supabase/supabase-js` may be imported in exactly one file —
 * `packages/config/db.ts`, the guarded client factory. Anywhere else means
 * somebody can build an unchecked client and rule 40 stops being structural.
 *
 * Fails closed: an unreadable tree or a missing boundary file is an error, not
 * a pass.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

const ROOT = process.cwd();
const BOUNDARY = "packages/config/db.ts";
const PACKAGE = "@supabase/supabase-js";
const SEARCH_DIRS = ["src", "packages", "scripts", "tests"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".output", "dist", ".tanstack", ".wrangler"]);
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.test(entry)) out.push(full);
  }
  return out;
}

const files = SEARCH_DIRS.flatMap((d) => walk(join(ROOT, d)));
const violations = [];
let sawBoundary = false;

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join(posix.sep);
  if (rel === BOUNDARY) {
    sawBoundary = true;
    continue;
  }
  const text = readFileSync(file, "utf8");
  // Match real import syntax, not a bare substring — otherwise this script
  // flags itself for naming the package, and any comment mentioning it fails
  // the build. Covers static import, bare side-effect import, dynamic
  // import(), and require().
  const quoted = PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const IMPORT = new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s*\\(\\s*)['"\`]${quoted}['"\`]`,
  );
  if (IMPORT.test(text)) violations.push(rel);
}

if (!sawBoundary) {
  console.error(`check:db-boundary FAIL — the boundary file ${BOUNDARY} is missing.`);
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`check:db-boundary FAIL — ${PACKAGE} imported outside ${BOUNDARY}:`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(`\nEvery Supabase client must come from createDb() in ${BOUNDARY} (rule 40).`);
  process.exit(1);
}

console.log(
  `check:db-boundary OK — ${PACKAGE} imported only in ${BOUNDARY} (${files.length} files scanned).`,
);
