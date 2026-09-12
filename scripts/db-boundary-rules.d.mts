/**
 * Type surface for db-boundary-rules.mjs, so TypeScript tests can import the
 * matcher without `allowJs`. Keep in step with the exports in the .mjs file —
 * tests/db-boundary.test.ts is what breaks if these drift.
 *
 * Same arrangement as credential-shapes.d.mts, for the same reason.
 */

/** `@supabase/supabase-js` — named once, here and in the .mjs, never retyped. */
export declare const FORBIDDEN_PACKAGE: string;

/** Matches a real import of the forbidden package: import / from / require / import(). */
export declare const IMPORT: RegExp;

/** Matches a STANDALONE `db-boundary:allow` comment line (1F). */
export declare const ALLOW_PRAGMA: RegExp;

/** Repo-relative path prefixes whose files may use the pragma at all. */
export declare const PRAGMA_DIRS: readonly string[];

/** Whether the pragma is honoured for this repo-relative POSIX path. */
export declare const pragmaHonoured: (rel: string) => boolean;

/**
 * Blank the pragma line and exactly one following line; every other line is
 * returned unchanged. Line count is preserved.
 */
export declare const stripExemptLines: (text: string) => string;

/** Whether this file really imports the forbidden package, after any honoured exemption. */
export declare const violates: (rel: string, text: string) => boolean;

export interface DbBoundarySelfTestCase {
  readonly label: string;
  readonly rel: string;
  readonly text: string;
  readonly violates: boolean;
}

/** The shared case list run by both `--self-test` and tests/db-boundary.test.ts. */
export declare const selfTestCases: () => DbBoundarySelfTestCase[];
