#!/usr/bin/env node
// 2A (static half) -- schema parity, the part that needs no database.
//
// SPEC 2A's two SQL assertions, run against the FILE instead of a live schema:
//   1. no table in public may lack row-level security
//   2. no table in public may lack an org_id column
// plus FORCE ROW LEVEL SECURITY (2B hardening), so the table owner / service role
// cannot bypass policies either. CLAUDE.md rule 4: every business record has an
// explicit tenant boundary; rule 40: enforced structurally, not by convention.
//
// The deployed-vs-file half (pg_dump of the scratch project, diffed against this
// file) waits for 1D. This half runs in CI on every PR with no credentials at all,
// so drift in the FILE is caught before it can ever be deployed.
//
// HOW RLS IS ENABLED IN schema.sql -- and why a naive grep gets it wrong.
// The schema does not say `alter table X enable row level security` per table.
// It runs one DO block:
//     foreach t in array array['org','user',...] loop
//       execute format('alter table %I enable row level security', t);
// So a per-table search finds nothing and flags all 15 tables. This parser reads
// the loop's array literal and credits every name in it, and ALSO honours the
// per-table statement form, so either style keeps working.
//
// Exceptions live in supabase/schema.allowlist.json -- one entry per (table,
// invariant) with a one-line reason. Every entry must name a table that exists,
// so the allowlist cannot rot: a stale exemption fails the check.
//
// Usage:
//   node scripts/check-schema-parity.mjs                      # supabase/schema.sql + allowlist
//   node scripts/check-schema-parity.mjs path/to/other.sql    # any file, same allowlist
//   node scripts/check-schema-parity.mjs --no-allowlist FILE  # raw, no exemptions
//   node scripts/check-schema-parity.mjs --self-test          # prove the planted-bad fixture goes RED
//
// Added 2026-09-11 by Claude Code, ticket 2A (static half).

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export const INVARIANTS = ["org_id", "enable_rls", "force_rls"];

// ---------------------------------------------------------------------------
// Parsing. Comments stripped first so a commented-out statement never counts.
// ---------------------------------------------------------------------------

const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");

const unquote = (name) => name.replace(/^"(.*)"$/, "$1").toLowerCase();

/** Slice a balanced-parenthesis body starting at the index of its opening "(". */
function balancedBody(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  throw new Error(`unbalanced parentheses after offset ${openIndex}`);
}

/** Every `create table` in `sql` -> { name, body }. */
export function parseTables(sql) {
  const text = stripComments(sql);
  const tables = [];
  const re = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)\s*\(/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const openIndex = m.index + m[0].length - 1;
    tables.push({ name: unquote(m[1]), body: balancedBody(text, openIndex) });
  }
  return tables;
}

/** Top-level column/constraint clauses of a table body (commas inside parens ignored). */
function topLevelClauses(body) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export const hasOrgIdColumn = (body) =>
  topLevelClauses(body).some((clause) => /^"?org_id"?\s+uuid\b/i.test(clause));

/**
 * Tables with RLS `enable`d or `force`d, from BOTH statement styles:
 *   alter table X enable|force row level security;
 *   do $$ ... foreach t in array array['a','b'] loop execute format('... enable|force row level security', t) ...
 */
export function rlsTables(sql) {
  const text = stripComments(sql);
  const enabled = new Set();
  const forced = new Set();

  const perTable = /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)\s+(enable|force)\s+row\s+level\s+security\b/gi;
  let m;
  while ((m = perTable.exec(text)) !== null) {
    (m[2].toLowerCase() === "force" ? forced : enabled).add(unquote(m[1]));
  }

  // DO-block loops. Each `foreach ... in array array[...] loop ... end loop`
  // is examined on its own, so a file with one enable loop and one force loop
  // credits each correctly.
  const loop = /foreach\s+\w+\s+in\s+array\s+array\s*\[([^\]]*)\]\s*loop([\s\S]*?)end\s+loop/gi;
  while ((m = loop.exec(text)) !== null) {
    const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1].toLowerCase());
    const bodyText = m[2];
    if (/enable\s+row\s+level\s+security/i.test(bodyText)) names.forEach((n) => enabled.add(n));
    if (/force\s+row\s+level\s+security/i.test(bodyText)) names.forEach((n) => forced.add(n));
  }
  return { enabled, forced };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export function loadAllowlist(path) {
  if (!path) return [];
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${path}: allowlist must be a JSON array`);
  return raw;
}

/**
 * Returns { gaps, problems, tables }. `gaps` are unexempted violations. `problems`
 * are defects in the allowlist itself (stale table, bad invariant, missing reason)
 * -- those fail the check too, so exemptions cannot silently rot.
 */
export function checkSchema(sql, allowlist = []) {
  const tables = parseTables(sql);
  const names = new Set(tables.map((t) => t.name));
  const { enabled, forced } = rlsTables(sql);

  const problems = [];
  const exempt = new Set();
  allowlist.forEach((entry, i) => {
    const where = `allowlist[${i}]`;
    if (!entry || typeof entry !== "object") return problems.push(`${where}: not an object`);
    const table = String(entry.table ?? "").toLowerCase();
    if (!names.has(table)) problems.push(`${where}: table "${entry.table}" does not exist in the schema (stale exemption)`);
    if (!INVARIANTS.includes(entry.invariant)) problems.push(`${where}: invariant "${entry.invariant}" is not one of ${INVARIANTS.join("|")}`);
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 8) problems.push(`${where}: a one-line reason is required`);
    exempt.add(`${table}:${entry.invariant}`);
  });

  // RLS loops that name a table that does not exist: a typo there silently
  // leaves the real table unprotected, so it is a defect, not noise.
  for (const n of [...enabled, ...forced]) {
    if (!names.has(n)) problems.push(`RLS statement names "${n}", which is not a table in this file`);
  }

  const gaps = [];
  const rows = [];
  for (const t of tables) {
    const status = {
      org_id: hasOrgIdColumn(t.body),
      enable_rls: enabled.has(t.name),
      force_rls: forced.has(t.name),
    };
    rows.push({ table: t.name, ...status });
    for (const inv of INVARIANTS) {
      if (!status[inv] && !exempt.has(`${t.name}:${inv}`)) gaps.push({ table: t.name, invariant: inv });
    }
  }
  if (tables.length === 0) problems.push("no `create table` statements found -- wrong file?");
  return { gaps, problems, tables: rows };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printMatrix(rows) {
  const w = Math.max(5, ...rows.map((r) => r.table.length));
  console.log(`  ${"table".padEnd(w)}  org_id  enable  force`);
  for (const r of rows) {
    const cell = (v) => (v ? "  ok  " : " MISS ");
    console.log(`  ${r.table.padEnd(w)}  ${cell(r.org_id)}  ${cell(r.enable_rls)}  ${cell(r.force_rls)}`);
  }
}

function run(schemaPath, allowlistPath, { quiet = false } = {}) {
  const sql = readFileSync(schemaPath, "utf8");
  const allowlist = loadAllowlist(allowlistPath);
  const result = checkSchema(sql, allowlist);
  if (!quiet) {
    console.log(`check-schema-parity: ${schemaPath} -- ${result.tables.length} tables, ${allowlist.length} allowlisted exceptions`);
    printMatrix(result.tables);
  }
  return result;
}

function selfTest() {
  // The fixture plants a table with NO org_id that is NOT in the RLS loop, next to
  // a fully compliant one. With no allowlist, the check MUST go red on exactly the
  // planted table, and MUST stay green on the good one. If this ever passes green,
  // the parser is broken and the gate is decorative.
  const fixture = resolve("tests/fixtures/schema-bad.sql");
  const result = run(fixture, undefined, { quiet: true });
  const bad = result.gaps.filter((g) => g.table === "bad_table").map((g) => g.invariant).sort();
  const good = result.gaps.filter((g) => g.table === "good_table");
  const expected = ["enable_rls", "force_rls", "org_id"];
  const ok =
    result.gaps.length === 3 &&
    JSON.stringify(bad) === JSON.stringify(expected) &&
    good.length === 0 &&
    result.problems.length === 0;
  if (!ok) {
    console.error("SELF-TEST FAIL -- the planted-bad fixture did not produce exactly the expected gaps.");
    console.error("  gaps:", JSON.stringify(result.gaps), " problems:", JSON.stringify(result.problems));
    process.exit(1);
  }
  console.log(`self-test: PASS -- planted bad_table flagged for ${bad.join(", ")}; good_table clean (including per-table FORCE).`);
}

const isMain = import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href
  || process.argv[1]?.endsWith("check-schema-parity.mjs");

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    selfTest();
    process.exit(0);
  }
  const noAllow = args.includes("--no-allowlist");
  const positional = args.filter((a) => !a.startsWith("--"));
  const schemaPath = positional[0] ?? "supabase/schema.sql";
  const allowlistPath = noAllow ? undefined : positional[1] ?? "supabase/schema.allowlist.json";
  if (!existsSync(schemaPath)) {
    console.error(`check-schema-parity: ${schemaPath} does not exist`);
    process.exit(2);
  }
  const result = run(schemaPath, allowlistPath && existsSync(allowlistPath) ? allowlistPath : undefined);

  if (result.problems.length) {
    console.error("\nALLOWLIST / SCHEMA DEFECTS:");
    for (const p of result.problems) console.error(`  - ${p}`);
  }
  if (result.gaps.length) {
    console.error("\nFAIL -- tenant-boundary invariants missing (rule 4 / rule 40):");
    for (const g of result.gaps) console.error(`  ${g.table.padEnd(14)} ${g.invariant}`);
    console.error("\nEither fix the schema, or add an entry to supabase/schema.allowlist.json with a one-line reason.\n");
  }
  if (result.problems.length || result.gaps.length) process.exit(1);
  console.log("check-schema-parity: OK -- every table has org_id, ENABLE and FORCE row level security (or a reasoned exemption).");
}
