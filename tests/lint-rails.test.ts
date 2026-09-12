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
import { readFileSync } from "node:fs";
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
