import { afterEach, describe, expect, it } from "vitest";

import { assertNotProd, createDb } from "../packages/config/db.ts";
import { resetEnvCache } from "../packages/config/env.ts";
import { KillSwitchTrip } from "../packages/config/kill-switch.ts";
import { declareProcessKind, resetDeclaredProcessKind } from "../packages/config/process-kind.ts";

const PROD_REF = "efeaylkqgqhobookcqby";

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** A structurally valid anon key for `ref`, so classification agrees with the URL. */
const anonKey = (ref: string) =>
  [
    b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    b64url(JSON.stringify({ iss: "supabase", role: "anon", ref })),
    "sig",
  ].join(".");

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
    declareProcessKind("agent", "tests/db-boundary.test.ts"); // what agents/** does at import
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
    // JWT-shaped for the scrubber's pattern rail: anonKey() signs with a 3-char "sig",
    // and the JWT shape needs >= 4 chars per segment, so lengthen the signature.
    const serviceValue = anonKey(SCRATCH_REF) + "nature";
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
