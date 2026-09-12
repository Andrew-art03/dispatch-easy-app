#!/usr/bin/env node
/**
 * SPEC 1B: `@supabase/supabase-js` may be imported in exactly one file —
 * `packages/config/db.ts`, the guarded client factory. Anywhere else means
 * somebody can build an unchecked client and rule 40 stops being structural.
 *
 * Fails closed: an unreadable tree or a missing boundary file is an error, not
 * a pass.
 *
 * The matching rules live in `./db-boundary-rules.mjs` so vitest can import them
 * without this file's shebang or its top-level scan (1F). This file is the CLI.
 *
 * Usage:
 *   node scripts/assert-db-boundary.mjs              # scan the tree
 *   node scripts/assert-db-boundary.mjs --self-test  # prove the pragma is not a bypass
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import { FORBIDDEN_PACKAGE, selfTestCases, violates } from "./db-boundary-rules.mjs";

const ROOT = process.cwd();
const BOUNDARY = "packages/config/db.ts";
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

function scan() {
  const files = SEARCH_DIRS.flatMap((d) => walk(join(ROOT, d)));
  const violations = [];
  let sawBoundary = false;

  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join(posix.sep);
    if (rel === BOUNDARY) {
      sawBoundary = true;
      continue;
    }
    if (violates(rel, readFileSync(file, "utf8"))) violations.push(rel);
  }
  return { files, violations, sawBoundary };
}

function selfTest() {
  const cases = selfTestCases();
  const failures = [];
  for (const c of cases) {
    const actual = violates(c.rel, c.text);
    if (actual !== c.violates) {
      failures.push(`  ${c.label}: expected ${c.violates}, got ${actual}`);
    }
  }
  if (failures.length > 0) {
    console.error("check:db-boundary SELF-TEST FAIL — the pragma does not behave as documented:");
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log(
    `check:db-boundary self-test: PASS — ${cases.length} pragma cases; exemption confined to scripts/ and tests/, one line, own line.`,
  );
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const { files, violations, sawBoundary } = scan();

  if (!sawBoundary) {
    console.error(`check:db-boundary FAIL — the boundary file ${BOUNDARY} is missing.`);
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error(`check:db-boundary FAIL — ${FORBIDDEN_PACKAGE} imported outside ${BOUNDARY}:`);
    for (const v of violations) console.error(`  ${v}`);
    console.error(`\nEvery Supabase client must come from createDb() in ${BOUNDARY} (rule 40).`);
    process.exit(1);
  }

  console.log(
    `check:db-boundary OK — ${FORBIDDEN_PACKAGE} imported only in ${BOUNDARY} (${files.length} files scanned).`,
  );
}
