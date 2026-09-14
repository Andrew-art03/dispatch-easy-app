/**
 * EZ-BUILD-01 Slice 1 — the suite watching its own size (BUILD_DEFAULTS R-2).
 *
 * `scripts/assert-test-floor.mjs` reads vitest's JSON report after the run and so
 * can see what was actually COLLECTED. This file runs inside the suite and so
 * cannot. They answer different halves of the same question and both are needed:
 *
 *   - the script catches a file that stopped contributing tests;
 *   - this catches a test file that stopped EXISTING, and catches the gate
 *     itself being quietly unwired — `passWithNoTests` flipped back, the floor
 *     check dropped out of `bun run test`, the mandated numbers edited down.
 *
 * The last group also re-proves the hashbang fix from a second, independent
 * file: importing any `scripts/*.mjs` from a test was a `SyntaxError` until
 * vitest.config.ts landed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs gate script, no type declarations; plain JS on purpose
// so CI can run it with bare node, before any build step exists.
import { checkFloor } from "../scripts/assert-test-floor.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

const floor = JSON.parse(read("scripts/test-floor.json")) as {
  mandated: { files: number; tests: number };
  observed: { files: number; tests: number };
};

/** Every `*.test.ts` on disk, in the directories the config collects from. */
const testFilesOnDisk = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/`);
      else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) found.push(rel);
    }
  };
  for (const root of ["tests", "agents", "packages", "src", "supabase", "scripts"]) {
    try {
      walk(root, `${root}/`);
    } catch {
      // A root that does not exist yet is not a failure; later slices add some.
    }
  }
  return found.sort();
};

describe("the mandated floor is 12 files / 268 tests and cannot be edited down", () => {
  it("scripts/test-floor.json still states the ticket's mandated floor", () => {
    // These two numbers come from EZ-BUILD-01 section B item 8 and BUILD_DEFAULTS
    // R-2. They are a floor, not a target — they go up, never down, and a slice
    // that "fixes" a red suite by lowering them has defeated the whole gate.
    expect(floor.mandated).toEqual({ files: 12, tests: 268 });
  });

  it("the last accepted run is at or above the mandated floor", () => {
    expect(floor.observed.files).toBeGreaterThanOrEqual(floor.mandated.files);
    expect(floor.observed.tests).toBeGreaterThanOrEqual(floor.mandated.tests);
  });
});

describe("the gate is wired in, not merely present", () => {
  it("vitest refuses to pass a file that collects nothing", () => {
    // The 2026-09-13 defect in one line: without this, `agent-imports.test.ts`
    // collecting zero tests is indistinguishable from it collecting sixteen.
    expect(read("vitest.config.ts")).toMatch(/passWithNoTests:\s*false/);
  });

  it("vitest writes the JSON report the floor check reads", () => {
    const config = read("vitest.config.ts");
    expect(config).toMatch(/reporters:\s*\[\s*"default",\s*"json"\s*\]/);
    expect(config).toMatch(/\.vitest\/results\.json/);
  });

  it("`bun run test` runs the floor check after vitest, not instead of it", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const testScript = pkg.scripts["test"] ?? "";
    expect(testScript).toContain("vitest run");
    expect(testScript).toContain("assert-test-floor.mjs");
    // `&&`, so a red suite short-circuits and the floor check never gets the
    // chance to report on a run that did not finish.
    expect(testScript).toMatch(/vitest run.*&&.*assert-test-floor/);
  });
});

describe("the test files themselves are still on disk", () => {
  const files = testFilesOnDisk();

  it(`there are at least ${floor.mandated.files} test files`, () => {
    expect(files.length).toBeGreaterThanOrEqual(floor.mandated.files);
  });

  it("1F's two structural rails are among them", () => {
    // Named, not counted. A rail can be deleted while the total holds because
    // some other slice added two files that week.
    expect(files).toContain("tests/agent-imports.test.ts");
    expect(files).toContain("tests/db-boundary.test.ts");
  });
});

describe("the floor check goes red on a planted positive", () => {
  const floors = { mandated: { files: 12, tests: 268 }, observed: { files: 12, tests: 268 } };
  const healthy = {
    numTotalTests: 268,
    testResults: Array.from({ length: 12 }, (_, i) => ({
      name: `tests/file-${i}.test.ts`,
      assertionResults: Array.from({ length: 23 }, () => ({})),
    })),
  };
  const check = (report: unknown) =>
    (checkFloor as (r: unknown, f: unknown) => { failures: string[] })(report, floors);

  it("is green on a healthy run", () => {
    expect(check(healthy).failures).toEqual([]);
  });

  it("fails on the exact 2026-09-13 shape: one file collecting zero tests", () => {
    const planted = {
      ...healthy,
      testResults: healthy.testResults.map((r, i) => (i === 3 ? { ...r, assertionResults: [] } : r)),
    };
    const { failures } = check(planted);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/collected 0 tests/);
  });

  it("fails when a file drops out of collection entirely", () => {
    const { failures } = check({ ...healthy, testResults: healthy.testResults.slice(1) });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join(" ")).toMatch(/11 test files/);
  });

  it("fails when tests are lost while the file count holds", () => {
    const { failures } = check({ ...healthy, numTotalTests: 267 });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join(" ")).toMatch(/267 tests/);
  });

  it("does not treat an empty report as vacuously green", () => {
    expect(check({ numTotalTests: 0, testResults: [] }).failures.length).toBeGreaterThan(0);
  });
});
