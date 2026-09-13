/**
 * P-1C-1 (panel pass, 2026-09-11): the skills/runner lint ban must hold in EVERY
 * spelling, and this test is what stops it silently regressing.
 *
 * The finding: `no-restricted-syntax` selectors match shapes, and a shape can be
 * rewritten. Probed before the fix, five of eight spellings in the fixture passed
 * `bun run lint` under the agents/skills override — `process["env"]`,
 * `const { env } = process`, `Bun.env`, `import.meta.env`, `const p = process`.
 *
 * Mechanism: the fixture lives under tests/lint-fixtures/ (so `eslint .` sees a
 * valid file under the base config) but is linted here with a VIRTUAL path under
 * agents/skills/, which is what selects the override. Each `// form:` line is
 * asserted individually, so a regression names the exact spelling that reopened.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const FIXTURE = fileURLToPath(new URL("./lint-fixtures/env-bypass.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Form = { line: number; name: string };

function formsIn(source: string): Form[] {
  const forms: Form[] = [];
  // `\r?\n`, not `\n`: on a Windows checkout (core.autocrlf=true, and this repo
  // has no .gitattributes until F-20) every line keeps a trailing `\r`. `\r` is
  // a JS line terminator, so `.` in the regex below cannot match it and `$`
  // never lands — `forms` came back empty and the suite was red on Windows only.
  // CI is Linux and never saw it. Pre-existing; found on a fresh clone at 1F.
  source.split(/\r?\n/).forEach((text, index) => {
    const m = /\/\/ form: (.+)$/.exec(text);
    if (m?.[1]) forms.push({ line: index + 1, name: m[1].trim() });
  });
  return forms;
}

async function lintAs(source: string, virtualPath: string) {
  const eslint = new ESLint({ cwd: REPO_ROOT, overrideConfigFile: "eslint.config.js" });
  const results = await eslint.lintText(source, { filePath: virtualPath });
  const result = results[0];
  if (!result) throw new Error("ESLint returned no result");
  const errorsByLine = new Map<number, string[]>();
  for (const msg of result.messages) {
    if (msg.severity !== 2) continue;
    errorsByLine.set(msg.line, [...(errorsByLine.get(msg.line) ?? []), msg.ruleId ?? "?"]);
  }
  return errorsByLine;
}

describe("P-1C-1: raw environment access is an ERROR in skills, in every spelling", () => {
  const source = readFileSync(FIXTURE, "utf8");
  const forms = formsIn(source);

  it("the fixture still carries every known bypass form", () => {
    expect(forms.map((f) => f.name)).toEqual([
      "process.env (baseline, was already caught)",
      'computed process["env"]',
      "destructured { env } = process",
      "Bun.env",
      "Deno.env.get (was already caught)",
      "import.meta.env",
      "aliased process",
      "globalThis.process.env (was already caught)",
    ]);
  });

  it("every form produces at least one lint ERROR under the agents/skills override", async () => {
    const errors = await lintAs(source, "agents/skills/__lint_fixture__/env-bypass.ts");
    for (const form of forms) {
      expect(errors.get(form.line), `form "${form.name}" (fixture line ${form.line}) must be an error`).toBeTruthy();
    }
  });

  it("the same forms are errors under agents/runner too", async () => {
    const errors = await lintAs(source, "agents/runner/__lint_fixture__/env-bypass.ts");
    for (const form of forms) {
      expect(errors.get(form.line), `form "${form.name}" must be an error in the runner`).toBeTruthy();
    }
  });

  it("negative control: the ban is scoped to skills/runner, not the whole repo", async () => {
    // `process.env` is legitimate in src/ and packages/config — that is where the
    // sanctioned reads live. The override must not leak out of its glob.
    const errors = await lintAs(source, "src/__lint_fixture__/env-bypass.ts");
    const banRules = new Set(["no-restricted-globals", "no-restricted-syntax"]);
    const leaked = [...errors.values()].flat().filter((rule) => banRules.has(rule));
    expect(leaked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1F/N-4 — the declaration reset is named in exactly two places
// ---------------------------------------------------------------------------

/**
 * `resetDeclaredProcessKind()` used to be exported from
 * `packages/config/process-kind.ts` as "Test-only. Drops the declaration so a
 * case can start from a clean process." Nothing made that true. It un-declares
 * an agent process, which means rule 40's check in `createDb()` stops running
 * for the rest of that process — a bypass shipping from production source under
 * a name that reads like housekeeping.
 *
 * The panel asked for it to move to a test-only module. In plain ESM an export
 * is reachable by anything that can name the module, so what is actually
 * enforceable is the NAME: `__resetDeclaredProcessKind` is defined in one file
 * and named in exactly one other, `tests/support/process-kind.ts`, which is
 * what tests import. This is the check that makes that true rather than
 * intended, and it is a scan, so it sees a call, a re-export and a string alike.
 */
describe("1F/N-4: __resetDeclaredProcessKind is named in exactly two files", () => {
  const SCAN_DIRS = ["agents", "packages", "src", "scripts", "supabase", "tests"];
  const SKIP_DIRS = new Set(["node_modules", ".git", ".output", "dist", ".tanstack", ".wrangler"]);
  const EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

  /**
   * Three files, and the third is this one.
   *
   *   packages/config/process-kind.ts — defines it
   *   tests/support/process-kind.ts   — the seam, the only sanctioned way in
   *   tests/lint-rails.test.ts        — this rail, which has to name what it bans
   *
   * Excluding the rail from its own scan would make the file whose whole job is
   * this rule the only file nobody checks, which is the same trade 1F already
   * made for `db-boundary:allow` on the rails that plant real imports. The
   * exemption is one named path, not a pattern, and the case below pins the
   * list at exactly these three so it cannot quietly grow.
   */
  const ALLOWED = new Set([
    "packages/config/process-kind.ts",
    "tests/support/process-kind.ts",
    "tests/lint-rails.test.ts",
  ]);

  const RESET_NAME = ["__reset", "DeclaredProcessKind"].join(""); // not a hit on itself

  const violates = (rel: string, text: string) => !ALLOWED.has(rel) && text.includes(RESET_NAME);

  const walk = (dir: string, out: string[] = []): string[] => {
    let entries: string[];
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
  };

  it("goes red on a planted positive, wherever it sits", () => {
    // Seen to fail first: before the move, `packages/config/env.ts` could have
    // called this and nothing would have said a word.
    expect(violates("src/routes/index.tsx", `import { ${RESET_NAME} } from "x";`)).toBe(true);
    expect(violates("agents/guardrails.ts", `${RESET_NAME}();`)).toBe(true);
    expect(violates("tests/whatever.test.ts", `${RESET_NAME}();`)).toBe(true);
  });

  it("permits the two files that are supposed to name it", () => {
    expect(violates("packages/config/process-kind.ts", `export function ${RESET_NAME}() {}`)).toBe(
      false,
    );
    expect(violates("tests/support/process-kind.ts", `${RESET_NAME}();`)).toBe(false);
  });

  it("this repo names it nowhere else", () => {
    const files = SCAN_DIRS.flatMap((d) => walk(join(REPO_ROOT, d)));
    expect(files.length).toBeGreaterThan(0); // a scan that finds nothing passes for the wrong reason
    const offenders = files
      .map((f) => relative(REPO_ROOT, f).split(sep).join(posix.sep))
      .filter((rel) => violates(rel, readFileSync(join(REPO_ROOT, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the allowlist is exactly three files and every one of them really names it", () => {
    expect([...ALLOWED].sort()).toEqual([
      "packages/config/process-kind.ts",
      "tests/lint-rails.test.ts",
      "tests/support/process-kind.ts",
    ]);
    for (const rel of ALLOWED) {
      expect(readFileSync(join(REPO_ROOT, rel), "utf8")).toContain(RESET_NAME);
    }
  });
});
