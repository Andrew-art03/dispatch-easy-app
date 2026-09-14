#!/usr/bin/env node
// EZ-BUILD-01 Slice 6 -- packages/domain/** is PURE. BUILD_DEFAULTS section 3.
//
// WHAT "PURE" MEANS HERE, AND WHY EACH PART OF IT IS LOAD-BEARING.
//
//   no model import   -- CLAUDE.md rule 2: money math is deterministic TypeScript with unit
//                        tests, and an LLM never computes a number. A domain module that can
//                        reach a model is a domain module where that rule is a promise.
//   no DB client      -- rule 40: createDb() is the only factory. Domain logic that can read
//                        the database is logic whose result depends on which tenant asked.
//   no network        -- a pure function's test does not need a network, and a function whose
//                        test needs a network is a function nobody will test the hard cases of.
//   no environment    -- same reason, plus rule 41: a module that reads a secret is a module
//                        inside the blast radius of that secret.
//   no clock, no rng  -- BUILD_DEFAULTS R-4 is about money being reproducible. A number you
//                        cannot re-derive tomorrow from the same inputs is not evidence, and
//                        "estimated net" has to be re-derivable from provenance (Slice 10).
//
// Every finding names the file, the line and the rule. A rail whose output is a count is a
// rail people learn to scroll past.
//
//   node scripts/assert-domain-purity.mjs              # the real tree
//   node scripts/assert-domain-purity.mjs --self-test  # prove every rule goes red
//
// Plain .mjs so bare node runs it, before any build step exists.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

export const DOMAIN_ROOT = "packages/domain";

/**
 * One entry per rule. `test` receives a single line with its `--` and `//` comments already
 * removed, so a comment EXPLAINING a ban is never itself a violation -- a mistake this rail's
 * sibling (the db-boundary check) had to be taught twice.
 */
export const RULES = [
  {
    id: "no-bare-import",
    // Anything that is not a relative path is a dependency on the outside world. That covers
    // the model SDKs and the database client without having to enumerate them, and it covers
    // the next one nobody has thought of yet.
    test: (line) => {
      const m = /\b(?:import|export)\b[^"']*["']([^"']+)["']/.exec(line);
      if (!m) return false;
      const spec = m[1];
      return !(spec.startsWith("./") || spec.startsWith("../"));
    },
    why: "packages/domain may import only relative paths. A bare specifier is a dependency on something outside the domain.",
  },
  {
    id: "no-dynamic-import",
    test: (line) => /\bimport\s*\(/.test(line) || /\brequire\s*\(/.test(line),
    why: "A dynamic import is an import the static rules above cannot see.",
  },
  {
    id: "no-network",
    test: (line) => /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bnavigator\.sendBeacon\b/.test(line),
    why: "No network. A pure function's test does not need one.",
  },
  {
    id: "no-environment",
    test: (line) =>
      /\bprocess\s*\.\s*env\b|\bDeno\s*\.\s*env\b|\bBun\s*\.\s*env\b|import\s*\.\s*meta\s*\.\s*env\b|\bprocess\s*\[\s*["']env/.test(
        line,
      ),
    why: "No environment access (rule 41). A module that can read a secret is inside that secret's blast radius.",
  },
  {
    id: "no-clock",
    test: (line) => /\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)|\bperformance\s*\.\s*now\s*\(/.test(line),
    why: "No clock. Pass the instant in as an argument, or the same inputs stop producing the same number tomorrow (R-4).",
  },
  {
    id: "no-randomness",
    test: (line) => /\bMath\s*\.\s*random\s*\(|\bcrypto\s*\.\s*randomUUID\s*\(|\bcrypto\s*\.\s*getRandomValues\s*\(/.test(line),
    why: "No randomness. A number that cannot be re-derived from its inputs is not evidence.",
  },
  {
    id: "no-globals",
    test: (line) => /\bglobalThis\s*\.|\bprocess\s*\.\s*(cwd|argv|exit)\b|\bwindow\s*\.|\bdocument\s*\./.test(line),
    why: "No ambient globals. Everything is a function of its arguments.",
  },
];

const stripComments = (line) => line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");

/** Lines inside a /* ... *\/ block, so a multi-line explanation is not scanned as code. */
function codeLines(source) {
  const out = [];
  let inBlock = false;
  source.split(/\r?\n/).forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = line.indexOf("/*");
      if (start === -1) break;
      const end = line.indexOf("*/", start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        inBlock = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    const code = stripComments(line).trim();
    if (code) out.push({ n: i + 1, code });
  });
  return out;
}

/** @param {{path: string, source: string}[]} files */
export function checkPurity(files) {
  const violations = [];
  for (const file of files) {
    for (const { n, code } of codeLines(file.source)) {
      for (const rule of RULES) {
        if (rule.test(code)) violations.push({ file: file.path, line: n, rule: rule.id, why: rule.why, code });
      }
    }
  }
  return { violations, scanned: files.length };
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// self-test -- one planted positive per rule, each seen to go red
// ---------------------------------------------------------------------------

function selfTest() {
  const clean = `
/**
 * A comment may mention process.env, fetch( and Math.random( freely -- explaining a ban is not
 * committing one, and a rail that cannot tell the difference gets disabled by the first person
 * who has to document something.
 */
import { helper } from "./helper.ts";
// Date.now() in a line comment is also fine.
export const add = (a: number, b: number): number => a + b + helper;
`;

  const planted = [
    // A planted fixture string, written to prove the purity rail catches the database client.
    // It is never imported -- it is an argument to checkPurity(). The pragma exempts exactly
    // the ONE line after it, so it has to be the last comment line before the fixture.
    // db-boundary:allow
    ["no-bare-import", `import { createClient } from "@supabase/supabase-js";`],
    ["no-bare-import", `import Anthropic from "@anthropic-ai/sdk";`],
    ["no-bare-import", `import { readFileSync } from "node:fs";`],
    ["no-dynamic-import", `const m = await import("./maybe.ts");`],
    ["no-network", `const r = await fetch("https://example.test");`],
    ["no-environment", `const k = process.env.ANTHROPIC_API_KEY;`],
    ["no-environment", `const k = Deno.env.get("SUPABASE_SERVICE_ROLE");`],
    ["no-clock", `const at = Date.now();`],
    ["no-randomness", `const id = crypto.randomUUID();`],
    ["no-globals", `const g = globalThis.fetchLike;`],
  ];

  let bad = 0;

  const cleanResult = checkPurity([{ path: "clean.ts", source: clean }]);
  if (cleanResult.violations.length !== 0) {
    bad++;
    console.log(`  FAIL a clean module with comments about the bans is green -- got ${JSON.stringify(cleanResult.violations)}`);
  } else {
    console.log("  ok   a clean module is green, and comments mentioning a ban are not violations");
  }

  for (const [expected, line] of planted) {
    const { violations } = checkPurity([{ path: "planted.ts", source: line }]);
    const hit = violations.some((v) => v.rule === expected);
    if (!hit) bad++;
    console.log(`  ${hit ? "ok  " : "FAIL"} ${expected.padEnd(18)} caught: ${line.trim()}`);
  }

  // The rule that would otherwise pass for the wrong reason: a relative import is allowed.
  const rel = checkPurity([{ path: "ok.ts", source: `import { x } from "../other/x.ts";` }]);
  const relOk = rel.violations.length === 0;
  if (!relOk) bad++;
  console.log(`  ${relOk ? "ok  " : "FAIL"} a relative import is still allowed, so the rule is not just "no imports"`);

  if (bad > 0) {
    console.error(`\nassert-domain-purity --self-test: FAIL -- ${bad} case(s) did not behave as specified.`);
    process.exit(1);
  }
  console.log("\nassert-domain-purity --self-test: OK -- every rule goes red on its planted positive.");
}

// ---------------------------------------------------------------------------

const invokedPath = process.argv[1] ?? "";
const isMain =
  invokedPath.endsWith("assert-domain-purity.mjs") ||
  import.meta.url === new URL(`file://${invokedPath.replace(/\\/g, "/")}`).href;

if (isMain) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    if (!existsSync(DOMAIN_ROOT)) {
      console.error(`assert-domain-purity: ${DOMAIN_ROOT} does not exist. A purity rail with nothing to check is not a pass.`);
      process.exit(2);
    }
    const paths = walk(DOMAIN_ROOT);
    if (paths.length === 0) {
      console.error(`assert-domain-purity: ${DOMAIN_ROOT} contains no modules. A rail that finds nothing passes for the wrong reason.`);
      process.exit(2);
    }
    const files = paths.map((p) => ({
      path: relative(process.cwd(), p).split(sep).join(posix.sep),
      source: readFileSync(p, "utf8"),
    }));
    const { violations, scanned } = checkPurity(files);

    if (violations.length > 0) {
      console.error(`assert-domain-purity FAIL -- ${violations.length} violation(s) in ${scanned} module(s):\n`);
      for (const v of violations) {
        console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.code}`);
        console.error(`      ${v.why}\n`);
      }
      process.exit(1);
    }
    console.log(
      `assert-domain-purity OK -- ${scanned} module(s) under ${DOMAIN_ROOT}: no bare import, no dynamic import,\n` +
        `no network, no environment, no clock, no randomness, no ambient global.`,
    );
  }
}
