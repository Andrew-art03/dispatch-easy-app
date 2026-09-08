/**
 * Install the pre-commit hook. SPEC 1C: "Pre-commit is convenience; CI is the gate."
 *
 * OPT-IN ON PURPOSE — this is not wired to npm/bun `prepare`.
 *
 * A `prepare` script writes into `.git/hooks` on every `install`, which means
 * cloning the repo silently arms code that runs on the developer's machine. That
 * is the same shape as the supply-chain incidents in doc 24, and CLAUDE.md rule 30
 * says a human reads a tool's source before it is armed. Run it deliberately:
 *
 *     bun run hooks:install
 *
 * Skipping it costs you nothing but a slower feedback loop — CI still blocks.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO, "scripts", "hooks", "pre-commit");
const HOOKS_DIR = path.join(REPO, ".git", "hooks");
const DEST = path.join(HOOKS_DIR, "pre-commit");

if (!fs.existsSync(SRC)) {
  console.error(`install-hooks: source hook missing at ${SRC}`);
  process.exit(2);
}

if (!fs.existsSync(HOOKS_DIR)) {
  console.error(`install-hooks: ${HOOKS_DIR} does not exist — not a git working copy?`);
  process.exit(2);
}

// Rule 26: never build a destructive path by concatenation, and never clobber
// blind. If a hook is already there and is not ours, say so and stop rather than
// overwrite someone's work.
if (fs.existsSync(DEST)) {
  const existing = fs.readFileSync(DEST, "utf8");
  if (!existing.includes("EZ-TRUCKING-PRE-COMMIT")) {
    console.error(
      `install-hooks: refusing to overwrite an existing pre-commit hook at ${DEST}\n` +
        `  Move it aside and re-run if you want ours.`,
    );
    process.exit(2);
  }
}

fs.copyFileSync(SRC, DEST);
try {
  fs.chmodSync(DEST, 0o755); // no-op on Windows, required elsewhere
} catch {
  /* chmod is not meaningful on every platform */
}

// Rule 39: read back and prove the filesystem actually changed the way we claim.
const written = fs.readFileSync(DEST, "utf8");
if (written !== fs.readFileSync(SRC, "utf8")) {
  console.error("install-hooks: read-back mismatch — hook NOT installed correctly");
  process.exit(2);
}

console.log(`install-hooks: OK — pre-commit installed at ${DEST} (${written.length} bytes)`);
