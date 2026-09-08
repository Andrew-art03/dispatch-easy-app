#!/usr/bin/env node
// EZ-002 / 1A step 6 -- hard safety rail (CLAUDE.md rule 6).
// Fails the build if a Supabase SERVICE-ROLE credential reaches the build output.
// Added 2026-09-07 by Claude Code, ticket EZ-002.
//
// This is the AFTER-build half of the rail. assert-no-secret-source.mjs (check:env)
// is the before-build half; the credential patterns both use live in one shared
// module so tightening one cannot leave the other behind.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { findCredentialValues, isBinary } from "./credential-shapes.mjs";

const TARGET = process.argv[2] ?? ".output";

if (!existsSync(TARGET)) {
  console.error(`assert-no-service-role: "${TARGET}" does not exist -- run the build first.`);
  process.exit(1);
}

const hits = [];
let scanned = 0;

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }

    let buf;
    try {
      buf = readFileSync(p);
    } catch {
      continue; // unreadable (permissions, race with a concurrent build)
    }
    // Skip images/fonts/wasm by content. The previous version tried to skip them
    // with `catch { continue; // binary }`, but readFileSync(p,"utf8") does not
    // throw on binary input -- it returns replacement characters -- so that arm
    // never ran and every asset was scanned as text.
    if (isBinary(buf)) continue;

    scanned++;
    for (const why of findCredentialValues(buf.toString("utf8"))) hits.push({ file: p, why });
  }
};
walk(TARGET);

if (hits.length > 0) {
  console.error("\nFAIL -- service-role credential material found in the build output:\n");
  for (const h of hits) console.error(`  ${h.file}  <-  ${h.why}`);
  console.error("\nThis is a rule-6 stop. Rotate the key; do not just delete the file.\n");
  process.exit(1);
}

console.log(`assert-no-service-role: OK -- scanned ${scanned} text files under ${TARGET}, no service-role credential present.`);
