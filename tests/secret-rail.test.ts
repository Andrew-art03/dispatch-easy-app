/**
 * P-1C-4 (panel pass, 2026-09-11): the `secret-rail:allow` pragma is honoured
 * ONLY as a standalone comment on the line PRECEDING the exempted line.
 *
 * The finding: check:env used to drop any line that merely CONTAINED the pragma
 * text. So `const k = "<real key>"; // secret-rail:allow` passed the rail — the
 * exemption mechanism was itself a bypass. Every fixture here is assembled at
 * runtime so no tracked file holds a credential shape (the same doctrine
 * .gitleaks.toml and tests/secrets.test.ts already follow).
 */
import { describe, expect, it } from "vitest";

import {
  ALLOW_PRAGMA,
  findCredentialValues,
  findPublishedSecretNames,
  stripExemptLines,
} from "../scripts/credential-shapes.mjs";

const shape = (...parts: string[]) => parts.join("");
const FAKE_SB_SECRET = shape("sb", "_", "secret", "_", "AaBbCcDd11223344");
const PUBLISHED_NAME = shape("VITE_", "SUPABASE_", "SERVICE_ROLE_KEY");

const hits = (text: string) => [
  ...findPublishedSecretNames(stripExemptLines(text)),
  ...findCredentialValues(stripExemptLines(text)),
];

describe("P-1C-4: secret-rail:allow is a preceding-line pragma, never a same-line substring", () => {
  it("NEGATIVE: a credential on a line that also says secret-rail:allow is STILL a hit", () => {
    // The exact bypass the review demonstrated. Before P-1C-4 this passed.
    const text = `const k = "${FAKE_SB_SECRET}"; // secret-rail:allow`;
    expect(hits(text).length).toBeGreaterThan(0);
  });

  it("NEGATIVE: a published-secret NAME on a same-line-pragma line is still a hit", () => {
    const text = `const n = import.meta.env.${PUBLISHED_NAME}; // secret-rail:allow`;
    expect(hits(text).length).toBeGreaterThan(0);
  });

  it("POSITIVE: a standalone pragma line exempts exactly the ONE line after it", () => {
    const text = [
      "// secret-rail:allow  documentation example, not a live value",
      `const doc = "${FAKE_SB_SECRET}";`,
      `const leak = "${FAKE_SB_SECRET}";`, // third line: NOT covered by the pragma
    ].join("\n");
    const found = hits(text);
    expect(found.length).toBeGreaterThan(0); // the third line still fires
    // And the exempted second line is blank in the scanned text, not removed:
    const scanned = stripExemptLines(text).split("\n");
    expect(scanned).toHaveLength(3);
    expect(scanned[0]).toBe("");
    expect(scanned[1]).toBe("");
    expect(scanned[2]).toContain("leak");
  });

  it("POSITIVE: the pragma works with //, #, /* and * comment markers", () => {
    for (const marker of ["//", "#", "/*", "*"]) {
      const text = [`${marker} secret-rail:allow reason`, `k=${FAKE_SB_SECRET}`].join("\n");
      expect(hits(text), `marker ${marker}`).toEqual([]);
    }
  });

  it("the pragma must be the FIRST thing on its line — a comment that merely mentions it is not a pragma", () => {
    expect(ALLOW_PRAGMA.test("// secret-rail:allow why")).toBe(true);
    expect(ALLOW_PRAGMA.test("   // secret-rail:allow why")).toBe(true);
    expect(ALLOW_PRAGMA.test("x // secret-rail:allow")).toBe(false);
    expect(ALLOW_PRAGMA.test("// see secret-rail:allow above")).toBe(false);
    expect(ALLOW_PRAGMA.test("// secret-rail:allowed")).toBe(false); // word boundary
  });

  it("a pragma on the last line of a file exempts nothing and does not throw", () => {
    const text = [`k=${FAKE_SB_SECRET}`, "// secret-rail:allow"].join("\n");
    expect(hits(text).length).toBeGreaterThan(0);
    expect(stripExemptLines(text).split("\n")).toHaveLength(2);
  });

  it("line numbers are preserved: exempted lines become empty lines, not deleted lines", () => {
    const text = ["a", "// secret-rail:allow r", "b", "c"].join("\n");
    expect(stripExemptLines(text).split("\n")).toEqual(["a", "", "", "c"]);
  });
});
