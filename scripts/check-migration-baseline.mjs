#!/usr/bin/env node
// 1D (static half) -- the baseline migration must BE the schema, byte for byte.
//
// SPEC 1D "done when": migration files hash-matched to HQ/schema.sql. The repo's
// copy of that file is supabase/schema.sql (2A, itself a byte copy of HQ), and
// supabase/migrations/0001_baseline.sql must equal it exactly. One baseline
// file, not a guessed 0001/0002 split of what prod once had.
//
// WHY LINE ENDINGS ARE NORMALISED FIRST. This repo has core.autocrlf=true on
// Andrew's Windows checkout and no .gitattributes (renormalisation waits for
// F-20). The same blob therefore hashes differently on Windows (CRLF in the
// working tree) and on the Linux CI runner (LF). Found 2026-09-11: identical
// sha1 at copy time, different sha256 one checkout later. A check that passes
// on one platform and fails on the other is a check that lies, so both files
// are compared with CRLF folded to LF. Content is what must match, and a stray
// CR is not content.
//
// Added 2026-09-11 by Claude Code, ticket 1D (static half).

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

const SCHEMA = "supabase/schema.sql";
const BASELINE = "supabase/migrations/0001_baseline.sql";

const normalise = (buf) => buf.toString("utf8").replace(/\r\n/g, "\n");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

for (const f of [SCHEMA, BASELINE]) {
  if (!existsSync(f)) {
    console.error(`check-migration-baseline: ${f} does not exist`);
    process.exit(2);
  }
}

const schema = normalise(readFileSync(SCHEMA));
const baseline = normalise(readFileSync(BASELINE));
const a = sha256(schema);
const b = sha256(baseline);

console.log(`check-migration-baseline: ${SCHEMA}                 sha256 ${a.slice(0, 16)}… (${schema.length} chars, LF-normalised)`);
console.log(`check-migration-baseline: ${BASELINE}  sha256 ${b.slice(0, 16)}…`);

if (a !== b) {
  console.error(
    "\nFAIL -- the baseline migration is not byte-identical to the schema.\n" +
      "The schema is frozen (schema.sql header, rule 28). If it changed on purpose, that is a new\n" +
      "NNNN_*.sql migration with the `migration` label and Andrew's review -- never an edit to 0001.\n",
  );
  process.exit(1);
}
console.log("check-migration-baseline: OK -- 0001_baseline.sql is the schema, byte for byte (line endings normalised).");
