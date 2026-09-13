import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertNotProd, createDb } from "../packages/config/db.ts";
import { getEnv, resetEnvCache } from "../packages/config/env.ts";
import { KillSwitchTrip } from "../packages/config/kill-switch.ts";
import { resetDeclaredProcessKind } from "./support/process-kind.ts";

/**
 * Regression test for the kill-switch cache bypass (Gemini, adversarial review).
 *
 * `getEnv()` resolves lazily and memoises. The bug: it memoised *unconditionally
 * and forever*. Anything that resolved the environment during startup — a
 * build-time evaluation, a healthcheck route, a test bootstrap — before the real
 * target variables were populated would cache a benign verdict permanently.
 * Every later `createDb()` then read that stale object, `envClass === "prod"` was
 * false, and `killSwitchTrip("prod_target", …)` never fired. Rule 40 defeated
 * without anyone touching the kill switch.
 *
 * The cases below deliberately do NOT call `resetEnvCache()` between the benign
 * resolution and the prod target. That is the entire point: production code has
 * no reason to call it, so a test that resets cannot observe the bug. The
 * existing suite in db-boundary.test.ts resets on every case, which is why it
 * passed throughout.
 */

const PROD_REF = "efeaylkqgqhobookcqby";
const SCRATCH_REF = "krwcnieffeasjczkwrlz";

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const anonKey = (ref: string) =>
  [
    b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    b64url(JSON.stringify({ iss: "supabase", role: "anon", ref })),
    "sig",
  ].join(".");

const MANAGED = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_DB_URL",
  "DATABASE_URL",
  "SUPABASE_POOLER_URL",
  "SUPABASE_ANON_KEY",
  "VITE_SUPABASE_ANON_KEY",
  "SCRATCH_SERVICE_ROLE",
  "SUPABASE_SERVICE_ROLE",
  "EZ_ENV_CLAIM",
  "EZ_PROCESS_KIND",
] as const;

/** Mutates the environment the way real startup does — WITHOUT dropping the memo. */
function mutateEnvNoReset(source: Record<string, string>) {
  for (const k of MANAGED) delete process.env[k];
  Object.assign(process.env, source);
}

/**
 * 1F/C-2: every case here models a process that has loaded no agent code, so
 * `EZ_PROCESS_KIND` is allowed to speak for it. Cleared before each case rather
 * than only after, because vitest shares module state across test files and a
 * sibling file that imports `agents/**` declares the process an agent in this
 * one too. The declaration's own precedence is tested in process-kind.test.ts.
 */
beforeEach(() => {
  resetDeclaredProcessKind();
});

afterEach(() => {
  for (const k of MANAGED) delete process.env[k];
  resetDeclaredProcessKind();
  resetEnvCache();
});

describe("getEnv memoisation must not outlive the environment it described", () => {
  it("re-resolves when the target changes, so a cached benign verdict cannot mask prod", () => {
    mutateEnvNoReset({
      SUPABASE_URL: `https://${SCRATCH_REF}.supabase.co`,
      SUPABASE_ANON_KEY: anonKey(SCRATCH_REF),
    });
    resetEnvCache();
    expect(getEnv().envClass).toBe("scratch");

    // Startup is over; the real target lands. Nothing calls resetEnvCache().
    mutateEnvNoReset({ SUPABASE_URL: `https://${PROD_REF}.supabase.co` });

    expect(getEnv().envClass).toBe("prod");
  });

  it("trips the kill switch on a prod target resolved after a benign one was cached", () => {
    mutateEnvNoReset({
      SUPABASE_URL: "http://localhost:54321",
      EZ_PROCESS_KIND: "app",
    });
    resetEnvCache();
    expect(getEnv().envClass).toBe("scratch"); // healthcheck-style early resolve

    // Agent process now reaches for prod. kind unset → agent (fails safe).
    mutateEnvNoReset({ SUPABASE_URL: `https://${PROD_REF}.supabase.co` });

    expect(() => createDb("user")).toThrow(KillSwitchTrip);
    expect(() => createDb("user")).toThrow(/prod_target/);
  });

  it("assertNotProd sees the current target, not the cached one", () => {
    mutateEnvNoReset({
      SUPABASE_URL: "http://localhost:54321",
      EZ_PROCESS_KIND: "app",
    });
    resetEnvCache();
    expect(() => assertNotProd("migration")).not.toThrow();

    mutateEnvNoReset({
      SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
      EZ_PROCESS_KIND: "app",
    });

    expect(() => assertNotProd("migration")).toThrow(/migration against prod/);
  });
});
