#!/usr/bin/env node
/**
 * SPEC-3B rule 5: `packages/domain/` must never import `agents/`.
 *
 * The True-Net calculator is the number a driver decides on. It has to be
 * reachable, runnable and testable without the agent runtime anywhere near it —
 * partly so the money math stays deterministic (rule 2), and partly so nothing
 * in the domain layer can be made to depend on a model's output by accident.
 *
 * This is a grep, not a type check, and that is deliberate: it catches the
 * import before the bundler or the type system has an opinion, and it keeps
 * working if someone reaches for a dynamic `import()` or a `require`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "packages/domain";

/** Any syntax that could pull `agents/` into the domain layer. */
const FORBIDDEN = [
  /\bfrom\s+["'][^"']*\bagents\//,
  /\bimport\s*\(\s*["'][^"']*\bagents\//,
  /\brequire\s*\(\s*["'][^"']*\bagents\//,
];

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
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(ROOT)) {
  const source = readFileSync(file, "utf8");
  source.split(/\r?\n/).forEach((line, index) => {
    if (FORBIDDEN.some((pattern) => pattern.test(line))) {
      violations.push(`  ${relative(".", file)}:${index + 1}  ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error("check:domain FAIL — packages/domain/ must not import agents/:");
  console.error(violations.join("\n"));
  console.error(
    "\nThe domain layer is deterministic and must be reachable without the agent runtime (SPEC-3B rule 5).",
  );
  process.exit(1);
}

console.log("assert-domain-purity: OK — packages/domain/ imports no agent code.");
