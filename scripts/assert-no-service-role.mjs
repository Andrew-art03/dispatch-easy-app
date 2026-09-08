#!/usr/bin/env node
// EZ-002 / 1A step 6 -- hard safety rail (CLAUDE.md rule 6).
// Fails the build if a Supabase SERVICE-ROLE credential reaches the build output.
// Added 2026-09-07 by Claude Code, ticket EZ-002.
//
// WHY THIS MATCHES VALUES, NOT WORDS.
// A first version banned the literal strings "service_role"/"sb_secret". It fired on
// five files -- all of them Supabase SDK code, e.g. the client's own key-type detector
// `e.startsWith("sb_publishable_") || e.startsWith("sb_secret_")`. Zero real keys. A
// rail that cries wolf gets switched off, so this one matches credential SHAPES:
//   1. sb_secret_ followed by actual key characters  (new-format secret key)
//   2. a JWT whose decoded payload carries role=service_role  (legacy service key)
//   3. SUPABASE_SERVICE_ROLE_KEY assigned a non-empty literal
//
// NOT flagged, deliberately: the anon/publishable key. VITE_* values are inlined into
// the browser bundle by design and tenant isolation rests on RLS, not on hiding it.
// service_role bypasses RLS entirely, which is why only it is a stop condition.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const TARGET = process.argv[2] ?? ".output";

if (!existsSync(TARGET)) {
  console.error(`assert-no-service-role: "${TARGET}" does not exist -- run the build first.`);
  process.exit(1);
}

const isServiceRoleJwt = (jwt) => {
  const payload = jwt.split(".")[1];
  if (!payload) return false;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json).role === "service_role";
  } catch {
    return false;
  }
};

const hits = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue; // binary
    }

    if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) hits.push({ file: p, why: "sb_secret_ key value" });

    for (const jwt of text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? []) {
      if (isServiceRoleJwt(jwt)) hits.push({ file: p, why: "JWT with role=service_role" });
    }

    if (/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'`][^"'`\s]{8,}/.test(text))
      hits.push({ file: p, why: "SUPABASE_SERVICE_ROLE_KEY assigned a literal" });
  }
};
walk(TARGET);

if (hits.length > 0) {
  console.error("\nFAIL -- service-role credential material found in the build output:\n");
  for (const h of hits) console.error(`  ${h.file}  <-  ${h.why}`);
  console.error("\nThis is a rule-6 stop. Rotate the key; do not just delete the file.\n");
  process.exit(1);
}

console.log(`assert-no-service-role: OK -- scanned ${TARGET}, no service-role credential present.`);
