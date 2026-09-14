#!/usr/bin/env node
// EZ-BUILD-01 Slice 1 — the collected-count gate (BUILD_DEFAULTS R-2).
//
// THE DEFECT THIS EXISTS FOR. On 2026-09-13 the suite reported
//
//     Test Files  1 failed | 11 passed (12)
//          Tests  252 passed (252)
//
// and the one failure was `tests/agent-imports.test.ts` collecting ZERO tests.
// That file IS 1F's import-graph gate — the thing that makes "an agent can never
// construct a database client" structural rather than a promise. Had it collected
// zero WITHOUT throwing (every `it` commented out, an `include` pattern narrowed
// by a merge, a describe accidentally skipped), vitest would have exited 0 and the
// rule would have shipped with its enforcement silently switched off. A green
// suite is not evidence of anything unless you also count what it collected.
//
// So: vitest's own exit code answers "did the tests that ran pass?". This answers
// the other question, the one nothing was asking — "did they all still run?"
//
// Three assertions, in order of how badly you want to know:
//   1. every collected file contributed at least one test;
//   2. collected files and tests are both >= the ticket's mandated floor;
//   3. neither has dropped below the last accepted run (the ratchet in
//      scripts/test-floor.json), so a regression between slices is red even while
//      still above the mandated floor.
//
// Run by `bun run test` after vitest, never instead of it.
//
//   node scripts/assert-test-floor.mjs              # gate the last run
//   node scripts/assert-test-floor.mjs --self-test  # prove the gate goes red
//
// Plain .mjs on purpose: bare node runs it, before any build step exists.

import { readFileSync, existsSync } from "node:fs";

const REPORT = ".vitest/results.json";
const FLOOR = "scripts/test-floor.json";

/**
 * The whole gate, as a pure function, so the self-test below exercises the real
 * code path with planted input rather than a re-implementation of it.
 *
 * @param {{numTotalTests?: number, testResults?: Array<{name: string, assertionResults?: unknown[]}>}} report
 * @param {{mandated: {files: number, tests: number}, observed: {files: number, tests: number}}} floor
 * @returns {{files: number, tests: number, failures: string[]}}
 */
export function checkFloor(report, floor) {
  const failures = [];
  const results = Array.isArray(report.testResults) ? report.testResults : [];
  const files = results.length;
  const tests = typeof report.numTotalTests === "number" ? report.numTotalTests : 0;

  // 1. A collected file that contributed nothing. The exact 2026-09-13 shape.
  for (const r of results) {
    const n = Array.isArray(r.assertionResults) ? r.assertionResults.length : 0;
    if (n === 0) {
      failures.push(`${rel(r.name)} collected 0 tests — a file that collects nothing is a FAILURE (R-2)`);
    }
  }

  // 2. The ticket's mandated floor. Never moves down.
  if (files < floor.mandated.files) {
    failures.push(`collected ${files} test files, below the mandated floor of ${floor.mandated.files}`);
  }
  if (tests < floor.mandated.tests) {
    failures.push(`collected ${tests} tests, below the mandated floor of ${floor.mandated.tests}`);
  }

  // 3. The ratchet: fewer than the last accepted run is a regression even when
  //    it is still above the mandated floor.
  if (files < floor.observed.files) {
    failures.push(
      `collected ${files} test files; the last accepted run collected ${floor.observed.files}. ` +
        `Fewer files than the previous slice is a FAILURE even if every reported test passed.`,
    );
  }
  if (tests < floor.observed.tests) {
    failures.push(`collected ${tests} tests; the last accepted run collected ${floor.observed.tests}`);
  }

  return { files, tests, failures };
}

const rel = (p) => String(p).replace(/\\/g, "/").replace(/^.*\/ez-app-ez010\//, "");

// ---------------------------------------------------------------------------
// self-test — planted positives that MUST go red
// ---------------------------------------------------------------------------

function selfTest() {
  const floor = { mandated: { files: 12, tests: 268 }, observed: { files: 12, tests: 268 } };
  const healthy = {
    numTotalTests: 268,
    testResults: Array.from({ length: 12 }, (_, i) => ({
      name: `tests/file-${i}.test.ts`,
      assertionResults: Array.from({ length: 23 }, () => ({})),
    })),
  };

  const cases = [
    ["a healthy run is accepted", healthy, 0],
    [
      "one file collecting 0 tests is red, even with the totals intact",
      {
        numTotalTests: 268,
        testResults: healthy.testResults.map((r, i) => (i === 3 ? { ...r, assertionResults: [] } : r)),
      },
      1,
    ],
    [
      "a file silently dropping out of collection is red",
      { numTotalTests: 268, testResults: healthy.testResults.slice(1) },
      2, // below mandated AND below the ratchet
    ],
    [
      "losing tests while the file count holds is red",
      { numTotalTests: 267, testResults: healthy.testResults },
      2,
    ],
    ["an empty report is red, not vacuously green", { numTotalTests: 0, testResults: [] }, 4],
  ];

  let bad = 0;
  for (const [name, report, expected] of cases) {
    const { failures } = checkFloor(report, floor);
    const ok = failures.length === expected;
    if (!ok) bad++;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${name} — ${failures.length} failure(s), expected ${expected}`,
    );
    for (const f of failures) console.log(`         ${f}`);
  }

  if (bad > 0) {
    console.error(`\nassert-test-floor --self-test: FAIL — ${bad} case(s) did not behave as specified.`);
    process.exit(1);
  }
  console.log("\nassert-test-floor --self-test: OK — the gate goes red on every planted positive.");
}

// ---------------------------------------------------------------------------

// Same main-module guard shape as scripts/assert-agent-imports.mjs. It is
// load-bearing, not ceremony: `tests/suite-floor.test.ts` imports `checkFloor`
// from this file, and without the guard that import RUNS the gate — reading
// whichever stale report happened to be on disk and, when it did not like it,
// calling process.exit() from inside a vitest worker. Found by planting the
// positive in Slice 1 and watching the wrong file go red.
const invokedPath = process.argv[1] ?? "";
const isMain =
  invokedPath.endsWith("assert-test-floor.mjs") ||
  import.meta.url === new URL(`file://${invokedPath.replace(/\\/g, "/")}`).href;

if (!isMain) {
  // imported for `checkFloor` — do nothing else
} else if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  for (const f of [REPORT, FLOOR]) {
    if (!existsSync(f)) {
      console.error(
        `assert-test-floor: ${f} does not exist.\n` +
          `The JSON report is written by vitest itself (vitest.config.ts, reporters: ["default","json"]).\n` +
          `If it is missing, the suite did not run — which is exactly the state this gate refuses to call green.`,
      );
      process.exit(2);
    }
  }

  const report = JSON.parse(readFileSync(REPORT, "utf8"));
  const floor = JSON.parse(readFileSync(FLOOR, "utf8"));
  const { files, tests, failures } = checkFloor(report, floor);

  console.log(
    `assert-test-floor: collected ${files} files / ${tests} tests ` +
      `(mandated floor ${floor.mandated.files}/${floor.mandated.tests}, ` +
      `last accepted ${floor.observed.files}/${floor.observed.tests})`,
  );

  if (failures.length > 0) {
    console.error("\nFAIL — the suite shrank:\n");
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      "\nA suite that collects nothing reports green exactly like one that collects sixteen.\n" +
        "Fix the collection, never the floor. Raising scripts/test-floor.json is only for a run\n" +
        "that legitimately collected MORE.\n",
    );
    process.exit(1);
  }

  if (files > floor.observed.files || tests > floor.observed.tests) {
    console.log(
      `assert-test-floor: the suite grew (${floor.observed.files}/${floor.observed.tests} -> ${files}/${tests}). ` +
        `Raise "observed" in ${FLOOR} in this slice's commit so the ratchet holds the new number.`,
    );
  }

  console.log("assert-test-floor: OK — every collected file contributed tests and nothing shrank.");
}
