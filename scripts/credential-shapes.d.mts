/**
 * Type surface for credential-shapes.mjs, so TypeScript tests can import the
 * detector without `allowJs`. Keep in step with the exports in the .mjs file —
 * tests/secret-rail.test.ts is what breaks if these drift.
 */
export declare const isBinary: (buf: Uint8Array) => boolean;

/** Matches a STANDALONE `secret-rail:allow` comment line (P-1C-4). */
export declare const ALLOW_PRAGMA: RegExp;

/**
 * Blank the pragma line and exactly one following line; every other line is
 * returned unchanged. Line count is preserved.
 */
export declare const stripExemptLines: (text: string) => string;

/** Human-readable descriptions of each credential VALUE shape found in `text`. */
export declare const findCredentialValues: (text: string) => string[];

/** Human-readable descriptions of each published (VITE_*) secret NAME found in `text`. */
export declare const findPublishedSecretNames: (text: string) => string[];
