#!/usr/bin/env node
// 1D (static half) -- run tests/schema/invariants.sql against the SCRATCH database.
//
// Three modes, and the middle one is the point:
//   SCRATCH_DB_URL absent            -> prints the literal line
//                                       `check:schema:live SKIPPED (no SCRATCH_DB_URL)` and exits 0.
//                                       A skip must be VISIBLE, never a silent green (1A v4 rule).
//   SCRATCH_DB_URL set, no driver    -> FAILS. A configured database that cannot be reached is not
//                                       a skip; it is a broken gate, and it says so (rule 30: the
//                                       driver is added only after a human reads its source).
//   SCRATCH_DB_URL set, driver here  -> runs every statement; any returned row is a violation.
//
// Rule 49: only SCRATCH_DB_URL is ever read. The prod ref is refused by 1B's classifier before a
// connection is attempted, and this script never echoes a connection string (rule 6).
//
// Added 2026-09-11 by Claude Code, ticket 1D (static half).

import { readFileSync } from "node:fs";

const url = process.env.SCRATCH_DB_URL;

if (!url) {
  console.log("check:schema:live SKIPPED (no SCRATCH_DB_URL)");
  process.exit(0);
}

// Structural refusal, before any driver: the prod project ref must never appear here.
if (/efeaylkqgqhobookcqby/.test(url)) {
  console.error("check:schema:live REFUSED -- SCRATCH_DB_URL points at the prod project (rule 49)");
  process.exit(1);
}

// EZ-BUILD-01 Slice 3: the file and its statement count are arguments, defaulting to exactly
// what they were before. Slice 3 adds tests/schema/rls.sql, which is the same kind of artifact
// -- statements that must return zero rows -- and duplicating this runner to read a second
// file would have been two runners to keep honest instead of one.
//
//   node scripts/check-schema-live.mjs                              # invariants.sql, 3 statements
//   node scripts/check-schema-live.mjs tests/schema/rls.sql 8       # the 2B proof
//
// The count stays MANDATORY. It is what stops a merge that silently drops a statement from
// reporting green on the ones that survived.
const positional = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const file = positional[0] ?? "tests/schema/invariants.sql";
const expected = Number(positional[1] ?? 3);

const statements = readFileSync(file, "utf8")
  .split(/^\s*;;\s*$/m)
  .map((chunk) => chunk.replace(/--[^\n]*/g, "").trim())
  .filter(Boolean);

if (statements.length !== expected) {
  console.error(`check:schema:live: expected ${expected} statements in ${file}, found ${statements.length}`);
  process.exit(2);
}

let postgres;
try {
  ({ default: postgres } = await import("postgres"));
} catch {
  console.error(
    "check:schema:live FAIL -- SCRATCH_DB_URL is set but no Postgres driver is installed (rule 30: not added until reviewed). " +
      "A configured database that cannot be checked is a broken gate, not a skip.",
  );
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });
let violations = 0;
try {
  for (const [i, statement] of statements.entries()) {
    const rows = await sql.unsafe(statement);
    if (rows.length > 0) {
      violations += rows.length;
      console.error(`invariant ${i + 1}: ${rows.length} violating table(s): ${rows.map((r) => Object.values(r)[0]).join(", ")}`);
    } else {
      console.log(`invariant ${i + 1}: OK (0 rows)`);
    }
  }
} finally {
  await sql.end();
}

if (violations > 0) {
  console.error(`\ncheck:schema:live FAIL -- ${violations} violation(s). These are invariants, not conventions.`);
  process.exit(1);
}
console.log("check:schema:live OK -- all three invariants returned zero rows.");
