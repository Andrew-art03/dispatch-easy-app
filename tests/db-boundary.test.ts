import { afterEach, describe, expect, it } from "vitest";

import { assertNotProd, createDb } from "../packages/config/db.ts";
import { resetEnvCache } from "../packages/config/env.ts";
import { KillSwitchTrip } from "../packages/config/kill-switch.ts";

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
  resetEnvCache();
}

afterEach(() => {
  for (const k of MANAGED) delete process.env[k];
  resetEnvCache();
});

describe("createDb — rule 40 enforcement at the factory", () => {
  it("trips the kill switch when an agent process reaches for prod", () => {
    setEnv({ SUPABASE_URL: `https://${PROD_REF}.supabase.co` }); // kind unset → agent
    expect(() => createDb("user")).toThrow(KillSwitchTrip);
    expect(() => createDb("user")).toThrow(/prod_target/);
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

  it("builds a user client with only VITE_SUPABASE_PUBLISHABLE_KEY set (the app's tracked env)", () => {
    setEnv({
      SUPABASE_URL: `https://${SCRATCH_REF}.supabase.co`,
      // sb_* is not a JWT: it must be accepted by readTarget and must NOT be
      // pushed through refOfJwt (it is deliberately absent from KEY_VARS).
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_AaBbCcDd11223344",
      EZ_PROCESS_KIND: "app",
    });
    expect(() => createDb("user")).not.toThrow();
  });

  it("builds a user client with SUPABASE_PUBLISHABLE_KEY (server-side name)", () => {
    setEnv({
      SUPABASE_URL: `https://${SCRATCH_REF}.supabase.co`,
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_AaBbCcDd11223344",
      EZ_PROCESS_KIND: "edge",
    });
    expect(() => createDb("user")).not.toThrow();
  });

  it("names both accepted key families when none is configured", () => {
    setEnv({ SUPABASE_URL: `https://${SCRATCH_REF}.supabase.co`, EZ_PROCESS_KIND: "app" });
    expect(() => createDb("user")).toThrow(/anon\/publishable key/);
  });
});
