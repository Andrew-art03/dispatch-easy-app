import { afterEach, describe, expect, it } from "vitest";

import { assertNotProd, createDb } from "../packages/config/db.ts";
import { resetEnvCache } from "../packages/config/env.ts";
import { KillSwitchTrip } from "../packages/config/kill-switch.ts";
import { declareAgentProcess } from "../packages/config/process-kind.ts";
import { resetDeclaredProcessKind } from "./support/process-kind.ts";

const PROD_REF = "efeaylkqgqhobookcqby";

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** A structurally valid JWT for `ref` in `role`, so classification agrees with the URL. */
const jwtFor = (ref: string, role: "anon" | "service_role") =>
  [
    b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    b64url(JSON.stringify({ iss: "supabase", role, ref })),
    "sig",
  ].join(".");

const anonKey = (ref: string) => jwtFor(ref, "anon");

/**
 * 1F/H-4: a *_SERVICE_ROLE variable must hold a credential that can actually
 * bypass RLS. Before H-4 these cases put an ANON key in SCRATCH_SERVICE_ROLE and
 * nothing objected — the name was treated as the capability. It is not; the
 * value is. The fixture was wrong, not the assertion it was supporting.
 */
const serviceKey = (ref: string) => jwtFor(ref, "service_role");

/** Every variable the classifier or the factory reads. Cleared between cases. */
const MANAGED = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_DB_URL",
  "DATABASE_URL",
  "SUPABASE_POOLER_URL",
  "SUPABASE_ANON_KEY",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_PUBLISHABLE_KEY", // P-1B-2
  "VITE_SUPABASE_PUBLISHABLE_KEY", // P-1B-2
  "SCRATCH_SERVICE_ROLE",
  "SUPABASE_SERVICE_ROLE",
  "EZ_ENV_CLAIM",
  "EZ_PROCESS_KIND",
] as const;

/**
 * `getEnv()` is lazy and memoised, so a case only has to set the variables and
 * drop the cache — no module reloading. That laziness is the whole reason the
 * factory can be the enforcement boundary rather than a boot-time assert.
 */
function setEnv(source: Record<string, string>) {
  for (const k of MANAGED) delete process.env[k];
  Object.assign(process.env, source);
  // 1F/C-2: these cases model a process that has loaded NO agent code, so
  // `EZ_PROCESS_KIND` is the only thing that can speak for it — the 1B
  // behaviour every assertion below was written against. Needed explicitly
  // because this file dynamically imports agents/secrets.ts further down for
  // the P-1C-2 scrubber cases, and that declares the process an agent for good.
  // Process-identity precedence has its own suite in tests/process-kind.test.ts.
  resetDeclaredProcessKind();
  resetEnvCache();
}

afterEach(() => {
  for (const k of MANAGED) delete process.env[k];
  resetDeclaredProcessKind();
  resetEnvCache();
});

describe("createDb — rule 40 enforcement at the factory", () => {
  it("trips the kill switch when an agent process reaches for prod", () => {
    setEnv({ SUPABASE_URL: `https://${PROD_REF}.supabase.co` }); // kind unset → agent
    expect(() => createDb("user")).toThrow(KillSwitchTrip);
    expect(() => createDb("user")).toThrow(/prod_target/);
  });

  /**
   * TICKET 1F item 1, the acceptance test as written: "EZ_PROCESS_KIND=app
   * inside an agent process must STILL be refused a prod client."
   *
   * Before 1F this case built a client and handed it back. The variable was the
   * only thing that decided whether the rule-40 check above ran, and the
   * variable is ordinary environment input — so the control protected against
   * forgetting and not against setting (ChatGPT panel, finding C-2).
   */
  it("refuses a prod client to a declared agent even with EZ_PROCESS_KIND=app set", () => {
    setEnv({
      SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
      SUPABASE_ANON_KEY: anonKey(PROD_REF),
      EZ_PROCESS_KIND: "app", // the bypass
    });
    declareAgentProcess("tests/db-boundary.test.ts"); // what agents/** does at import
    expect(() => createDb("user")).toThrow(KillSwitchTrip);
    expect(() => createDb("user")).toThrow(/process_kind/);
  });

  it("lets an app process build a user client against prod", () => {
    setEnv({
      SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
      SUPABASE_ANON_KEY: anonKey(PROD_REF),
      EZ_PROCESS_KIND: "app",
    });
    expect(() => createDb("user")).not.toThrow();
  });

  it("refuses a privileged client because the allowlist is empty in 1B", () => {
    setEnv({
      SUPABASE_URL: "http://localhost:54321",
      EZ_PROCESS_KIND: "app",
    });
    expect(() => createDb("privileged", { caller: "src/anything.ts" })).toThrow(/privilege/);
  });

  it("refuses a privileged client whose caller cannot be identified — unknown fails closed", () => {
    setEnv({
      SUPABASE_URL: "http://localhost:54321",
      EZ_PROCESS_KIND: "app",
    });
    expect(() => createDb("privileged")).toThrow(KillSwitchTrip);
  });

  it("still refuses an agent reaching prod through the pooler, where the hostname looks generic", () => {
    setEnv({
      SUPABASE_POOLER_URL: `postgres://postgres.${PROD_REF}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
      SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
    });
    expect(() => createDb("user")).toThrow(/prod_target/);
  });
});

describe("assertNotProd — defence in depth", () => {
  it("trips against prod", () => {
    setEnv({ SUPABASE_URL: `https://${PROD_REF}.supabase.co`, EZ_PROCESS_KIND: "app" });
    expect(() => assertNotProd("migration")).toThrow(/migration against prod/);
  });

  it("is silent against a local target", () => {
    setEnv({ SUPABASE_URL: "http://localhost:54321", EZ_PROCESS_KIND: "app" });
    expect(() => assertNotProd("migration")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// P-1B-2 (panel pass, 2026-09-11): the publishable-key name the app really uses
// ---------------------------------------------------------------------------

describe("readTarget — accepts the publishable-key names", () => {
  const SCRATCH_REF = "krwcnieffeasjczkwrlz";
  // Assembled at runtime: a literal key-shaped string in a tracked file is exactly
  // what gitleaks' generic-api-key rule fires on (it did, run 34618835730).
  const FAKE_PUBLISHABLE = ["sb_", "publishable_", "AaBbCcDd11223344"].join("");

  it("builds a user client with only VITE_SUPABASE_PUBLISHABLE_KEY set (the app's tracked env)", () => {
    setEnv({
      SUPABASE_URL: `https://${SCRATCH_REF}.supabase.co`,
      // sb_* is not a JWT: it must be accepted by readTarget and must NOT be
      // pushed through refOfJwt (it is deliberately absent from KEY_VARS).
      VITE_SUPABASE_PUBLISHABLE_KEY: FAKE_PUBLISHABLE,
      EZ_PROCESS_KIND: "app",
    });
    expect(() => createDb("user")).not.toThrow();
  });

  it("builds a user client with SUPABASE_PUBLISHABLE_KEY (server-side name)", () => {
    setEnv({
      SUPABASE_URL: `https://${SCRATCH_REF}.supabase.co`,
      SUPABASE_PUBLISHABLE_KEY: FAKE_PUBLISHABLE,
      EZ_PROCESS_KIND: "edge",
    });
    expect(() => createDb("user")).not.toThrow();
  });

  it("names both accepted key families when none is configured", () => {
    setEnv({ SUPABASE_URL: `https://${SCRATCH_REF}.supabase.co`, EZ_PROCESS_KIND: "app" });
    expect(() => createDb("user")).toThrow(/anon\/publishable key/);
  });
});

// ---------------------------------------------------------------------------
// P-1C-2 (panel pass, 2026-09-11): the keys the factory hands out are on the
// scrubber's PRIMARY rail (exact-value registry), not only the shape backstop
// ---------------------------------------------------------------------------

describe("P-1C-2: keys read by the factory are registered with the scrubber by name", () => {
  const SCRATCH_REF = "krwcnieffeasjczkwrlz";
  // Assembled at runtime so no tracked file holds a credential shape.
  const FAKE_PUBLISHABLE = ["sb_", "publishable_", "ZzYyXxWw99887766"].join("");

  it("after createDb('user') the publishable key is redacted BY NAME, not just by shape", async () => {
    const { scrub, resetSecretRegistry } = await import("../agents/secrets.ts");
    resetSecretRegistry();
    setEnv({
      SUPABASE_URL: `https://${SCRATCH_REF}.supabase.co`,
      VITE_SUPABASE_PUBLISHABLE_KEY: FAKE_PUBLISHABLE,
      EZ_PROCESS_KIND: "app",
    });
    createDb("user");
    // By NAME: the registry (exact match) runs before the shape patterns, so the
    // label is the variable name, which is what an operator needs to know.
    expect(scrub(`key=${FAKE_PUBLISHABLE} sent`)).toBe("key=[redacted:VITE_SUPABASE_PUBLISHABLE_KEY] sent");
    resetSecretRegistry();
  });

  it("after readServiceKey() the service-role key is redacted BY NAME", async () => {
    const { scrub, resetSecretRegistry } = await import("../agents/secrets.ts");
    const { readServiceKey } = await import("../packages/config/db.ts");
    resetSecretRegistry();
    // JWT-shaped for the scrubber's pattern rail: jwtFor() signs with a 3-char "sig",
    // and the JWT shape needs >= 4 chars per segment, so lengthen the signature.
    // role: service_role, because 1F/H-4 refuses an anon value under this name.
    const serviceValue = serviceKey(SCRATCH_REF) + "nature";
    setEnv({
      SUPABASE_URL: `https://${SCRATCH_REF}.supabase.co`,
      SCRATCH_SERVICE_ROLE: serviceValue,
      EZ_PROCESS_KIND: "edge",
    });
    expect(readServiceKey()).toBe(serviceValue);
    expect(scrub(`auth ${serviceValue} done`)).toBe("auth [redacted:SCRATCH_SERVICE_ROLE] done");
    resetSecretRegistry();
  });

  it("without the factory having run, the same values fall back to the SHAPE labels only", async () => {
    const { scrub, resetSecretRegistry } = await import("../agents/secrets.ts");
    resetSecretRegistry();
    // Proves the previous two tests are testing the registry, not the pattern rail.
    expect(scrub(`key=${FAKE_PUBLISHABLE}`)).toBe("key=[redacted:SB_PUBLISHABLE]");
    // Same lengthened signature as above: a 3-char "sig" segment is NOT JWT-shaped.
    expect(scrub(`auth ${anonKey(SCRATCH_REF) + "nature"}`)).toBe("auth [redacted:JWT]");
  });
});

/**
 * 1F — the `db-boundary:allow` pragma, and the proof it is not a bypass.
 *
 * These run the SAME case list as `node scripts/assert-db-boundary.mjs
 * --self-test`, imported rather than retyped, so the script's self-test and
 * these unit tests cannot drift into covering different halves.
 *
 * They live in vitest because `check:db-boundary` is not a CI step yet — it is
 * RED by design while `src/lib/supabase.ts` exists (F-20 / held item C-3) — and
 * `bun run test` is. A self-test only reachable through a script nobody runs is
 * not a gate. Same reasoning that put the import-graph walk into
 * tests/agent-imports.test.ts rather than waiting on a ci.yml line.
 */
describe("db-boundary:allow pragma (1F)", () => {
  const PACKAGE = "@supabase/supabase-js";
  const realImport = `import { createClient } from "${PACKAGE}";\n`;
  const pragma = "// db-boundary:allow — fixture text, not a live import";

  it("behaves exactly as the script's own self-test claims, case for case", async () => {
    const { selfTestCases, violates } = await import("../scripts/db-boundary-rules.mjs");
    const cases = selfTestCases();
    // Guard against an empty or truncated list quietly passing this test.
    expect(cases.length).toBeGreaterThanOrEqual(9);
    for (const c of cases) {
      expect(`${c.label}: ${violates(c.rel, c.text)}`).toBe(`${c.label}: ${c.violates}`);
    }
  });

  it("never exempts application code, whatever the comment says", async () => {
    const { violates } = await import("../scripts/db-boundary-rules.mjs");
    // This is the limit that makes the pragma narrower than 1C's secret-rail:allow.
    // A credential SHAPE is a heuristic and earns forgiveness; an import is not.
    expect(violates("src/sneaky.ts", `${pragma}\n${realImport}`)).toBe(true);
    expect(violates("packages/config/sneaky.ts", `${pragma}\n${realImport}`)).toBe(true);
    // And the same text IS forgiven inside the rails, so the test above is
    // measuring the directory rule and not a broken pragma.
    expect(violates("scripts/rail.mjs", `${pragma}\n${realImport}`)).toBe(false);
  });

  it("is never a same-line substring — P-1C-4's lesson, applied before it could bite", async () => {
    const { violates } = await import("../scripts/db-boundary-rules.mjs");
    // 1C shipped a pragma that dropped any line CONTAINING the text, so a real
    // credential could sit on the same line as its own excuse. This one has to
    // be on its own line, which also makes every exemption a greppable diff line.
    expect(violates("scripts/rail.mjs", `${realImport.trimEnd()} // db-boundary:allow\n`)).toBe(
      true,
    );
  });

  it("exempts one line only, and still flags a rail that did not ask", async () => {
    const { violates } = await import("../scripts/db-boundary-rules.mjs");
    expect(violates("scripts/rail.mjs", `${pragma}\nconst harmless = 1;\n${realImport}`)).toBe(true);
    expect(violates("scripts/rail.mjs", realImport)).toBe(true);
    expect(violates("tests/rail.test.ts", realImport)).toBe(true);
  });
});

/**
 * TICKET 1F item 6 — finding H-8: `callerModule()` is deny-only and may never
 * establish authorization.
 *
 * The ticket asked for a comment and a test proving an allowed intermediary
 * cannot launder a disallowed caller. The comment is in db.ts. This is the
 * demonstration, and it is deliberately written to keep working when someone
 * eventually replaces the mechanism.
 */
describe("1F/H-8 — callerModule is deny-only", () => {
  const scratchEnv = {
    SUPABASE_URL: "http://localhost:54321",
    // A user client needs a key to be built at all; the privileged cases below
    // never reach the reader, but the "not consulted for a user client" case does.
    VITE_SUPABASE_PUBLISHABLE_KEY: ["sb_", "publishable_", "AaBbCcDd11223344"].join(""),
    EZ_PROCESS_KIND: "app",
  };

  it("no caller string can buy a privileged client, however plausible it looks", () => {
    setEnv(scratchEnv);
    // `opts.caller` is an ordinary argument supplied by the caller. If naming
    // yourself convincingly were worth anything, one of these would work.
    const attempts = [
      "packages/config/db.ts",
      "scripts/migrate.ts", // the module 1D is expected to add to the allowlist
      "at createDb (packages/config/db.ts:1:1)",
      "<unknown>",
      "",
    ];
    for (const caller of attempts) {
      expect(() => createDb("privileged", { caller })).toThrow(KillSwitchTrip);
    }
    // And with no caller supplied at all — an unidentifiable caller fails closed
    // rather than being waved through.
    expect(() => createDb("privileged")).toThrow(KillSwitchTrip);
  });

  it("sees only the LAST hop — which is why it can deny and never grant", () => {
    setEnv(scratchEnv);
    // The laundering shape, concretely. `disallowedOuter` wants a privileged
    // client and cannot have one. It calls `intermediary`, which is the frame
    // createDb actually sees. Today both are refused because the allowlist is
    // empty; the point of this case is WHICH NAME the refusal reports.
    function intermediary() {
      return createDb("privileged");
    }
    function disallowedOuter() {
      return intermediary();
    }

    let detail = "";
    try {
      disallowedOuter();
    } catch (e) {
      detail = (e as Error).message;
    }

    expect(detail).toContain("privilege");
    // The identification names the intermediary and is blind to the originator.
    // If `intermediary` were ever added to PRIVILEGED_CALLERS, this is exactly
    // how `disallowedOuter` would obtain a client it was never granted: it does
    // not have to spoof anything, it just has to call something that is listed.
    // That is the whole argument for 1D's PrivilegedGrant (SPEC 1B v3.1 #4).
    expect(detail).toContain("intermediary");
    expect(detail).not.toContain("disallowedOuter");
  });

  it("is not consulted at all for a user client — deny-only means deny-path-only", () => {
    setEnv(scratchEnv);
    // A caller string that is refused for `privileged` has no effect on `user`,
    // which is what "used only to deny" has to mean in practice. If this ever
    // starts throwing, the mechanism has leaked onto the ordinary path.
    expect(() => createDb("user", { caller: "src/anything.ts" })).not.toThrow();
    expect(() => createDb("user")).not.toThrow();
  });
});
