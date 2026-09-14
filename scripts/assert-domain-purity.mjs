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
import { dirname, join, posix, relative, sep } from "node:path";

export const DOMAIN_ROOT = "packages/domain";

/**
 * The ONLY bare specifiers packages/domain may import, each with a reason.
 *
 * MERGE NOTE (Slice 7). The 4A branch shipped its own copy of this rail as a DENYLIST -- a list
 * of forbidden packages (@supabase/*, the model SDKs). This copy is an ALLOWLIST, which is
 * strictly stronger: a denylist is silent about the next package nobody has thought of yet,
 * and "nobody thought of it" is the normal way a dependency arrives. The two were reconciled
 * by keeping the allowlist AND absorbing 4A's named bans below as a second layer, so an edit
 * that loosens this set cannot silently reopen the specific packages SPEC-4A names.
 *
 * `zod` earns its place: it is a pure schema validator with no I/O, and SPEC-4A's whole point
 * is that extraction output is validated against a schema before anything downstream sees it
 * (CLAUDE.md rule 3). Hand-rolling that validation to satisfy a lint rule would be trading a
 * real guarantee for a cosmetic one.
 */
export const ALLOWED_PACKAGES = new Set(["zod"]);

/**
 * 4A's denylist, kept as a SECOND layer beneath the allowlist above. Belt and braces on purpose:
 * these are the specific reaches SPEC-4A names, and they should stay red even if someone widens
 * ALLOWED_PACKAGES one day without thinking it through.
 */
export const FORBIDDEN_PACKAGES = [
  /^@supabase\//,
  /^@anthropic-ai\//,
  /^openai$/,
  /^@google\/generative-ai$/,
  /^@aws-sdk\/client-bedrock/,
  /^langchain/,
];

/** Specifier shapes that reach an agent entrypoint or a client factory, relative or not. */
export const FORBIDDEN_PATHS = [
  { match: /(?:^|[\/])agents[\/]/, why: "an agent entrypoint -- importing it declares the process an agent at module init" },
  // Matched on `config/db.ts`, not `packages/config/db.ts`. A module INSIDE packages/domain
  // reaches the factory as `../config/db.ts` — the `packages/` segment is never in the
  // specifier, so 4A's original pattern could only ever have caught the import from outside
  // the directory it was policing. Found by the self-test, not by review.
  { match: /(?:^|[\\/])config[\\/]db\.ts$/, why: "the database client factory" },
  { match: /[\/]supabase(?:-client)?\.ts$/, why: "a database client module" },
];

/**
 * The module specifier a line IMPORTS, or undefined.
 *
 * The shapes that actually load a module, and nothing else:
 *   import x from "m" / import {x} from "m" / export {x} from "m"
 *   import "m"                                  (side effect)
 *   require("m") / import("m")                  (dynamic)
 *
 * WHY THIS IS FUSSY. The first version of the no-bare-import rule matched
 * `(?:import|export)[^"']*["']([^"']+)["']`, which reads
 *     export type StopType = "pickup" | "delivery";
 * as an import of the module "pickup" -- so every string-literal union type in the domain layer
 * was a violation. It surfaced the moment real 4A code was ported in (Slice 7) and not before,
 * because the state machine this rail was first written against happens to use `as const`
 * arrays rather than union types. A rail that cries wolf on ordinary type declarations is a
 * rail somebody switches off.
 */
export function specifierOf(line) {
  const m =
    /(?:^|[\s;])(?:import|export)[\s\S]*?\sfrom\s*["'`]([^"'`]+)["'`]/.exec(line) ??
    /^\s*import\s*["'`]([^"'`]+)["'`]/.exec(line) ??
    /(?:require|import)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/.exec(line);
  return m ? m[1] : undefined;
}

/**
 * One entry per rule. `test` receives a single line with its `--` and `//` comments already
 * removed, so a comment EXPLAINING a ban is never itself a violation -- a mistake this rail's
 * sibling (the db-boundary check) had to be taught twice.
 */
export const RULES = [
  {
    id: "no-bare-import",
    // An ALLOWLIST, not a denylist: a denylist is silent about the next package nobody has
    // thought of yet, and "nobody thought of it" is the normal way a dependency arrives.
    test: (line) => {
      const spec = specifierOf(line);
      if (spec === undefined) return false;
      if (spec.startsWith("./") || spec.startsWith("../")) return false;
      return !ALLOWED_PACKAGES.has(spec);
    },
    why: `packages/domain may import relative paths, plus exactly: ${[...ALLOWED_PACKAGES].join(", ")}. A bare specifier outside that set is a dependency the domain layer has not agreed to.`,
  },
  {
    // 4A's denylist, kept BENEATH the allowlist as a second layer. See ALLOWED_PACKAGES: if
    // someone ever widens that set without thinking it through, these stay red.
    id: "no-forbidden-package",
    test: (line) => {
      const spec = specifierOf(line);
      return spec !== undefined && FORBIDDEN_PACKAGES.some((re) => re.test(spec));
    },
    why: "A database client or a model SDK, named explicitly by SPEC-4A. Rule 2: an LLM never computes a number.",
  },
  {
    // The gap the allowlist does NOT cover, and 4A's rail did: `../../agents/guardrails.ts` is
    // a RELATIVE specifier, so "relative paths are fine" waves it straight through. Importing
    // an agent entrypoint is not inert -- it declares the process an agent at module init.
    id: "no-agent-or-client-path",
    test: (line) => {
      const spec = specifierOf(line);
      return spec !== undefined && FORBIDDEN_PATHS.some((f) => f.match.test(spec));
    },
    why: "The specifier reaches an agent entrypoint or a database client module, whether written as a package or as a relative path.",
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

/** @param {{path: string, source: string, chain?: string[]}[]} files */
/**
 * The same line with every string literal blanked to empty quotes.
 *
 * WHY. `no-globals` matches `document.` to catch the DOM global, and
 *     export const NEVER_GATED = ["load.read", "document.upload"] as const;
 * is a string containing "document." — so the rail flagged a plain array of feature names.
 * That is the "naming a thing is not doing it" mistake again, one level down: a rule about
 * CODE must not read a string literal as code.
 *
 * The two import rules opt OUT of this, because the specifier they inspect IS a string literal.
 */
const blankStrings = (line) =>
  line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");

/** Rules whose whole job is to inspect a string literal. Everything else sees blanked strings. */
const READS_STRING_LITERALS = new Set(["no-bare-import", "no-forbidden-package", "no-agent-or-client-path"]);

export function checkPurity(files) {
  const violations = [];
  for (const file of files) {
    for (const { n, code } of codeLines(file.source)) {
      const blanked = blankStrings(code);
      for (const rule of RULES) {
        const subject = READS_STRING_LITERALS.has(rule.id) ? code : blanked;
        if (rule.test(subject)) {
          violations.push({
            file: file.path,
            line: n,
            rule: rule.id,
            why: rule.why,
            code,
            chain: file.chain ?? [file.path],
          });
        }
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
// The transitive walk -- SPEC-4A acceptance 20
// ---------------------------------------------------------------------------
//
// WHY A WALK AND NOT A PER-FILE SCAN. This rail originally scanned the files under
// packages/domain and stopped there. That is a grep, and it is defeated by one hop:
//
//     packages/domain/thing.ts       export { probe } from "../__leaf__.ts";   <- legal, relative
// db-boundary:allow
//     packages/__leaf__.ts           import "@supabase/supabase-js";           <- never scanned
//
// Nothing in packages/domain breaks a rule, and the domain layer still reaches a database
// client. SPEC-4A's acceptance 20 asks for "a real walk, not a grep" and 4A's own copy of this
// rail did one; mine did not, and the 4A test suite caught it on the first run after the port
// (Slice 7). The walk follows RELATIVE specifiers wherever they lead, including out of
// packages/domain, and reports the chain so a violation names the entrypoint that reached it.

const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", "/index.ts", "/index.tsx"];

/** Is this path a readable FILE? The single injection point, so the walk is testable. */
const isFileOnDisk = (p) => {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Resolve a relative specifier against the importing file, or null if nothing is there. */
export function resolveRelative(fromFile, spec, isFile = isFileOnDisk) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const base = join(dirname(fromFile), spec);
  for (const ext of EXTENSIONS) {
    const candidate = `${base}${ext}`;
    // `isFile` is the ONLY filesystem question asked here. An earlier version called the real
    // statSync even when a predicate was injected, so the self-test's in-memory graph resolved
    // to nothing and the transitive case passed by finding no modules to check — a walk that
    // finds nothing looking exactly like a walk that found nothing wrong.
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Every module reachable from the entrypoints by following relative imports, each carrying the
 * chain that reached it. Unresolvable relative imports FAIL CLOSED: a specifier that cannot be
 * resolved is a specifier nobody checked, and skipping it is how a walk quietly becomes a grep.
 */
export function collectGraph(entries, readFile = (p) => readFileSync(p, "utf8"), isFile = isFileOnDisk) {
  const norm = (p) => relative(process.cwd(), p).split(sep).join(posix.sep);
  const seen = new Map();
  const unresolved = [];
  const queue = entries.map((p) => ({ path: p, chain: [norm(p)] }));

  while (queue.length > 0) {
    const { path, chain } = queue.shift();
    const key = norm(path);
    if (seen.has(key)) continue;
    const source = readFile(path);
    seen.set(key, { path: key, source, chain });

    for (const { code } of codeLines(source)) {
      const spec = specifierOf(code);
      if (spec === undefined || !(spec.startsWith("./") || spec.startsWith("../"))) continue;
      const target = resolveRelative(path, spec, isFile);
      if (target === null) {
        unresolved.push({ from: key, spec });
        continue;
      }
      if (!seen.has(norm(target))) queue.push({ path: target, chain: [...chain, norm(target)] });
    }
  }
  return { modules: [...seen.values()], unresolved };
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

  // The rules that would otherwise pass for the wrong reason.
  const green = [
    ["a relative import is still allowed, so the rule is not just \"no imports\"", `import { x } from "../other/x.ts";`],
    [`the allowlisted package is allowed: ${[...ALLOWED_PACKAGES].join(", ")}`, `import { z } from "zod";`],
    // The false positive that made this rail unusable against real 4A code (Slice 7).
    ["a string-literal union type is NOT an import", `export type StopType = "pickup" | "delivery" | "other";`],
    ["nor is a plain string constant that happens to sit on an export line", `export const LABEL = "from Dallas, TX";`],
    // The false positive found in Slice 11: a feature-name array that happens to contain the
    // text "document." is not a use of the DOM global.
    ["a string literal containing `document.` is not the DOM global", `export const NEVER_GATED = ["load.read", "document.upload"] as const;`],
    ["nor is a string containing `process.env` a read of the environment", `export const BANNED_HINT = "do not use process.env here";`],
  ];
  for (const [name, source] of green) {
    const { violations } = checkPurity([{ path: "ok.ts", source }]);
    const ok = violations.length === 0;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` -- got ${JSON.stringify(violations.map((v) => v.rule))}`}`);
  }

  // The gap the allowlist alone does not cover: a RELATIVE path that reaches an agent.
  const reaches = [
    ["no-agent-or-client-path", `import { guard } from "../../agents/guardrails.ts";`],
    ["no-agent-or-client-path", `import { createDb } from "../config/db.ts";`],
    ["no-agent-or-client-path", `import { supabase } from "../../src/lib/supabase.ts";`],
  ];
  for (const [expected, line] of reaches) {
    const { violations } = checkPurity([{ path: "planted.ts", source: line }]);
    const hit = violations.some((v) => v.rule === expected);
    if (!hit) bad++;
    console.log(`  ${hit ? "ok  " : "FAIL"} ${expected.padEnd(24)} caught a RELATIVE reach: ${line.trim()}`);
  }

  // SPEC-4A acceptance 20: the walk is a WALK. The violation lives one hop OUTSIDE
  // packages/domain, where a per-file scan of that directory can never see it.
  {
    const files = {
      "packages/domain/entry.ts": `export { probe } from "../leaf.ts";\n`,
      // db-boundary:allow
      "packages/leaf.ts": `import "@supabase/supabase-js";\nexport const probe = 1;\n`,
    };
    const { modules } = collectGraph(
      ["packages/domain/entry.ts"],
      (p) => files[p.split(sep).join(posix.sep)] ?? "",
      (p) => Object.prototype.hasOwnProperty.call(files, p.split(sep).join(posix.sep)),
    );
    const { violations } = checkPurity(modules);
    const hop = violations.find((v) => v.rule === "no-bare-import" || v.rule === "no-forbidden-package");
    const namesEntry = hop?.chain?.[0]?.includes("entry.ts") ?? false;
    const ok = hop !== undefined && namesEntry;
    if (!ok) bad++;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} a TRANSITIVE reach one hop outside packages/domain is caught, and the chain names the entrypoint`,
    );
  }

  // And the walk fails closed rather than skipping what it cannot resolve.
  {
    const files = { "packages/domain/entry.ts": `export { gone } from "./missing.ts";\n` };
    const { unresolved } = collectGraph(
      ["packages/domain/entry.ts"],
      (p) => files[p.split(sep).join(posix.sep)] ?? "",
      (p) => Object.prototype.hasOwnProperty.call(files, p.split(sep).join(posix.sep)),
    );
    const ok = unresolved.length === 1;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} an unresolvable relative import is reported, not silently skipped`);
  }

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
    // The WALK, not a scan of the directory (SPEC-4A acceptance 20).
    const { modules, unresolved } = collectGraph(paths);
    const { violations, scanned } = checkPurity(modules);

    if (unresolved.length > 0) {
      // Fail closed. A relative specifier that cannot be resolved is a specifier nobody
      // checked, and skipping it is how a walk quietly becomes a grep.
      console.error(`assert-domain-purity FAIL -- ${unresolved.length} unresolvable relative import(s):\n`);
      for (const u of unresolved) console.error(`  ${u.from}  ->  ${u.spec}  (cannot resolve)`);
      process.exit(1);
    }

    if (violations.length > 0) {
      console.error(`assert-domain-purity FAIL -- ${violations.length} violation(s) in ${scanned} module(s):\n`);
      for (const v of violations) {
        console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.code}`);
        // The chain, when the violation is not in the entrypoint itself. This is what makes a
        // transitive finding actionable: a reviewer needs the hop that introduced it, not just
        // the leaf that happens to hold the import.
        if (v.chain.length > 1) console.error(`      reached by: ${v.chain.join(" -> ")}`);
        if (v.rule === "no-agent-or-client-path") {
          // SPEC-4A acceptance 6's wording, kept verbatim so the acceptance test asserts the
          // sentence a reader will actually see.
          console.error(`      packages/domain must not import agents/ or a database client.`);
        }
        console.error(`      ${v.why}\n`);
      }
      process.exit(1);
    }
    console.log(
      `assert-domain-purity: OK -- ${scanned} module(s) reachable from ${DOMAIN_ROOT}: no bare import,\n` +
        `no dynamic import, no network, no environment, no clock, no randomness, no ambient global.`,
    );
  }
}
