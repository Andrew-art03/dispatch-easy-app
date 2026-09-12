// The rules behind `check:db-boundary`, separated from the CLI that runs them.
//
// Split for the same reason 1C split `credential-shapes.mjs` out of
// `assert-no-secret-source.mjs`: a rail whose logic is only reachable by
// shelling out to a script is a rail whose logic has no unit tests. This module
// has no shebang and no top-level side effect, so vitest can import it — which
// matters here because `check:db-boundary` is not a CI step yet (it is RED by
// design while `src/lib/supabase.ts` exists, F-20 / held item C-3) and
// `bun run test` is. Putting the rules here makes them gated today.

const PACKAGE = "@supabase/supabase-js";

// Match real import syntax, not a bare substring — otherwise the rail flags
// itself for naming the package, and any comment mentioning it fails the build.
// Covers static import, bare side-effect import, dynamic import(), and require().
const QUOTED = PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const FORBIDDEN_PACKAGE = PACKAGE;

export const IMPORT = new RegExp(
  "(?:\\bfrom\\s*|\\bimport\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s*\\(\\s*)['\"`]" + QUOTED + "['\"`]",
);

// ---------------------------------------------------------------------------
// The `db-boundary:allow` pragma — 1F, the two false positives on 1F's own files
// ---------------------------------------------------------------------------
//
// WHY IT EXISTS. The import-graph gate added at 1F (`scripts/assert-agent-imports.mjs`
// and `tests/agent-imports.test.ts`) has to WRITE a real import statement — it
// plants one in a throwaway file to prove the gate goes red on a positive, and its
// header quotes a re-export chain to explain the case a grep would sail past. The
// regex above cannot tell a planted fixture from a live import, so 1F's own rails
// flagged themselves. Excluding those two files would make the files whose whole
// job is this boundary the only files nobody scans, which is worse than the
// false positive.
//
// WHY IT IS NARROWER THAN 1C's `secret-rail:allow`. The exemption mechanism must
// not itself become the bypass — that was P-1C-4's lesson, where any line merely
// CONTAINING the pragma text was dropped from the scan, so a real credential
// could hide behind its own excuse. Two limits here, both proved by the
// self-test and again in tests/db-boundary.test.ts:
//
//   1. STANDALONE COMMENT LINE ONLY, exempting exactly ONE following line. Never a
//      same-line substring. Every exemption is therefore a visible, greppable
//      diff line with a reason on it.
//   2. HONOURED ONLY UNDER `scripts/` AND `tests/`. This boundary is the rule-40
//      structural invariant. Application code under `src/` or `packages/` may
//      never exempt itself from it, whatever it writes in a comment. 1C's pragma
//      is honoured everywhere because a credential SHAPE is a heuristic and false
//      positives are expected; an import is not a heuristic, so outside the rails
//      there is nothing to forgive.
//
// Both lines are replaced by EMPTY lines rather than removed, so line numbers in
// any later report still match the file.
export const ALLOW_PRAGMA = /^\s*(?:\/\/|#|\/\*|\*)\s*db-boundary:allow\b/;

/** Directories whose files may use the pragma. Everywhere else ignores it. */
export const PRAGMA_DIRS = ["scripts/", "tests/"];

/** `rel` is a repo-relative POSIX path. */
export const pragmaHonoured = (rel) => PRAGMA_DIRS.some((d) => rel.startsWith(d));

export function stripExemptLines(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (ALLOW_PRAGMA.test(lines[i])) {
      out.push(""); // the pragma line itself
      if (i + 1 < lines.length) {
        out.push(""); // exactly one following line
        i += 1;
      }
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** True if this file imports the forbidden package for real, after any honoured exemption. */
export function violates(rel, text) {
  return IMPORT.test(pragmaHonoured(rel) ? stripExemptLines(text) : text);
}

/**
 * The self-test cases. Exported as data so the CLI and vitest run the SAME list
 * and cannot drift apart — the failure mode where a rail's script-mode self-test
 * and its unit tests each cover a different half.
 *
 * The fixtures are STRINGS, never files. Writing a file that really imports the
 * forbidden package is the one thing this rail exists to prevent, and a crashed
 * run would leave it lying in the tree for the next person to find.
 */
export function selfTestCases() {
  const realImport = 'import { createClient } from "' + PACKAGE + '";\n';
  const pragma = "// db-boundary:allow — fixture text, not a live import";
  return [
    { label: "bare import in application code", rel: "src/thing.ts", text: realImport, violates: true },
    { label: "bare import in a rail, no pragma", rel: "scripts/rail.mjs", text: realImport, violates: true },
    { label: "bare import in a test, no pragma", rel: "tests/rail.test.ts", text: realImport, violates: true },
    {
      label: "pragma exempts the next line in scripts/",
      rel: "scripts/rail.mjs",
      text: pragma + "\n" + realImport,
      violates: false,
    },
    {
      label: "pragma exempts the next line in tests/",
      rel: "tests/rail.test.ts",
      text: pragma + "\n" + realImport,
      violates: false,
    },
    {
      label: "pragma does NOT exempt application code under src/",
      rel: "src/sneaky.ts",
      text: pragma + "\n" + realImport,
      violates: true,
    },
    {
      label: "pragma does NOT exempt application code under packages/",
      rel: "packages/config/sneaky.ts",
      text: pragma + "\n" + realImport,
      violates: true,
    },
    {
      label: "pragma on the SAME line does not exempt (P-1C-4's lesson)",
      rel: "scripts/rail.mjs",
      text: realImport.trimEnd() + " // db-boundary:allow\n",
      violates: true,
    },
    {
      label: "pragma exempts exactly ONE line, not the rest of the file",
      rel: "scripts/rail.mjs",
      text: pragma + "\nconst harmless = 1;\n" + realImport,
      violates: true,
    },
  ];
}
