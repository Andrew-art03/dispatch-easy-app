/**
 * TICKET 1F item 1 — process identity is not settable by environment (C-2).
 *
 * The defect: `EZ_PROCESS_KIND` was ordinary environment input, and it alone
 * decided whether `db.ts` ran rule 40's agent-cannot-touch-prod check. Set it to
 * `app` in an inherited environment, a launcher or a test harness and the check
 * never fired. The fail-closed default (`unset → agent`) protects against
 * forgetting the variable; nothing protected against setting it.
 *
 * The fix has two legs, both deny-only and neither reachable from the
 * environment: an explicit in-code declaration (`agents/agent-process.ts`), and
 * inference from the entrypoint path. Either outranks the variable. This suite
 * is the proof, including the ticket's own acceptance case.
 *
 * Ordering note: these cases reset the declaration themselves rather than
 * assuming a clean process. Vitest shares module state across test files, and
 * two sibling files import `agents/**`, which declares the process an agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb } from "../packages/config/db.ts";
import { UnknownEnvironment, getEnv, resetEnvCache, resolveEnv } from "../packages/config/env.ts";
import { KillSwitchTrip } from "../packages/config/kill-switch.ts";
import {
  declareProcessKind,
  declaredProcessKind,
  entrypointProcessKind,
  provenProcessKind,
  resetDeclaredProcessKind,
} from "../packages/config/process-kind.ts";

const PROD_REF = "efeaylkqgqhobookcqby";
const SCRATCH_REF = "krwcnieffeasjczkwrlz";
const PROD_URL = `https://${PROD_REF}.supabase.co`;
const SCRATCH_URL = `https://${SCRATCH_REF}.supabase.co`;

const MANAGED = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_DB_URL",
  "DATABASE_URL",
  "SUPABASE_POOLER_URL",
  "SUPABASE_ANON_KEY",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "SCRATCH_SERVICE_ROLE",
  "SUPABASE_SERVICE_ROLE",
  "EZ_ENV_CLAIM",
  "EZ_PROCESS_KIND",
] as const;

function setEnv(source: Record<string, string>) {
  for (const k of MANAGED) delete process.env[k];
  Object.assign(process.env, source);
  resetEnvCache();
}

beforeEach(() => {
  resetDeclaredProcessKind();
  resetEnvCache();
});

afterEach(() => {
  for (const k of MANAGED) delete process.env[k];
  resetDeclaredProcessKind();
  resetEnvCache();
});

// ---------------------------------------------------------------------------
// The bypass itself
// ---------------------------------------------------------------------------

describe("C-2: EZ_PROCESS_KIND cannot turn an agent into an app", () => {
  it("refuses a prod client to a declared agent that claims to be an app", () => {
    setEnv({ SUPABASE_URL: PROD_URL, EZ_PROCESS_KIND: "app" });
    declareProcessKind("agent", "agents/agent-process.ts");
    expect(() => createDb("user")).toThrow(KillSwitchTrip);
    expect(() => createDb("user")).toThrow(/process_kind/);
  });

  it("names both the claim and what overruled it, so the log says what happened", () => {
    setEnv({ SUPABASE_URL: PROD_URL, EZ_PROCESS_KIND: "app" });
    declareProcessKind("agent", "agents/agent-process.ts");
    expect(() => getEnv()).toThrow(/EZ_PROCESS_KIND=app contradicts agent/);
    expect(() => getEnv()).toThrow(/agents\/agent-process\.ts/);
  });

  it("refuses the contradiction against scratch too, not only against prod", () => {
    // The contradiction is about identity, not about the target. A process that
    // cannot say what it is does not get a client of any kind — resolving it as
    // "probably fine, it's only scratch" is how the unknown-is-safe class of bug
    // gets back in (same reasoning as UnknownEnvironment in 1B).
    setEnv({ SUPABASE_URL: SCRATCH_URL, EZ_PROCESS_KIND: "app" });
    declareProcessKind("agent", "agents/agent-process.ts");
    expect(() => getEnv()).toThrow(KillSwitchTrip);
  });

  it("is symmetric: a declared app cannot be demoted to an agent by the variable either", () => {
    setEnv({ SUPABASE_URL: SCRATCH_URL, EZ_PROCESS_KIND: "agent" });
    declareProcessKind("app", "src/entry-server.ts");
    expect(() => getEnv()).toThrow(/process_kind/);
  });

  it("accepts the variable when it agrees with the declaration", () => {
    setEnv({ SUPABASE_URL: SCRATCH_URL, EZ_PROCESS_KIND: "agent" });
    declareProcessKind("agent", "agents/agent-process.ts");
    expect(getEnv().kind).toBe("agent");
    expect(getEnv().kindSource).toBe("declared");
  });
});

// ---------------------------------------------------------------------------
// 1B behaviour that must NOT change: the app/edge opt-out still works when
// nothing in code has claimed the process
// ---------------------------------------------------------------------------

describe("unchanged 1B behaviour when no code has claimed the process", () => {
  it("EZ_PROCESS_KIND=app is honoured when there is no declaration", () => {
    setEnv({ SUPABASE_URL: SCRATCH_URL, EZ_PROCESS_KIND: "app" });
    expect(getEnv().kind).toBe("app");
    expect(getEnv().kindSource).toBe("env");
    expect(getEnv().isAgentProcess).toBe(false);
  });

  it("unset still means agent, and says so", () => {
    setEnv({ SUPABASE_URL: SCRATCH_URL });
    expect(getEnv().kind).toBe("agent");
    expect(getEnv().kindSource).toBe("default");
    expect(getEnv().isAgentProcess).toBe(true);
  });

  it("a garbage value is still an UnknownEnvironment, not a kill-switch trip", () => {
    // A typo is a typo. Keeping these two failures distinguishable matters:
    // one is someone mistyping "aget", the other is a process being told to lie
    // about what it is, and they want different responses from whoever reads it.
    setEnv({ SUPABASE_URL: SCRATCH_URL, EZ_PROCESS_KIND: "aget" });
    expect(() => getEnv()).toThrow(UnknownEnvironment);
    expect(() => getEnv()).not.toThrow(KillSwitchTrip);
  });

  it("a garbage value is rejected before the declaration is consulted", () => {
    setEnv({ SUPABASE_URL: SCRATCH_URL, EZ_PROCESS_KIND: "aget" });
    declareProcessKind("agent", "agents/agent-process.ts");
    expect(() => getEnv()).toThrow(UnknownEnvironment);
  });
});

// ---------------------------------------------------------------------------
// The declaration itself
// ---------------------------------------------------------------------------

describe("declareProcessKind", () => {
  it("starts undeclared, so nothing is claimed by accident", () => {
    expect(declaredProcessKind()).toBeUndefined();
  });

  it("records the first declaration", () => {
    declareProcessKind("agent", "agents/agent-process.ts");
    expect(declaredProcessKind()).toBe("agent");
    expect(provenProcessKind()).toEqual({ kind: "agent", source: "declared" });
  });

  it("is idempotent for the same kind — several agent modules may import it", () => {
    declareProcessKind("agent", "agents/guardrails.ts");
    expect(() => declareProcessKind("agent", "agents/actions.ts")).not.toThrow();
    expect(declaredProcessKind()).toBe("agent");
  });

  it("trips on a contradicting redeclaration rather than taking the last one", () => {
    declareProcessKind("agent", "agents/agent-process.ts");
    expect(() => declareProcessKind("app", "somewhere-else.ts")).toThrow(KillSwitchTrip);
    expect(() => declareProcessKind("app", "somewhere-else.ts")).toThrow(/process_kind/);
  });

  it("keeps the ORIGINAL declarer in the message, not the challenger", () => {
    declareProcessKind("agent", "agents/agent-process.ts");
    expect(() => declareProcessKind("app", "attacker.ts")).toThrow(
      /already declared "agent" by agents\/agent-process\.ts/,
    );
  });
});

// ---------------------------------------------------------------------------
// Leg B — the entrypoint, which needs no import discipline at all
// ---------------------------------------------------------------------------

describe("entrypointProcessKind — deny-only inference from argv", () => {
  const realArgv = process.argv;
  afterEach(() => {
    process.argv = realArgv;
  });

  const asEntry = (path: string) => {
    process.argv = [realArgv[0] ?? "node", path];
    return entrypointProcessKind();
  };

  it("claims agent for a posix agents/ entrypoint", () => {
    expect(asEntry("/home/ez/app/agents/run-triage.ts")).toBe("agent");
  });

  it("claims agent for a windows agents\\ entrypoint", () => {
    expect(asEntry("C:\\Users\\AAndew\\AutoDispatch\\ez-app\\agents\\run-triage.ts")).toBe("agent");
  });

  it("claims agent when agents/ is the whole relative path", () => {
    expect(asEntry("agents/run-triage.ts")).toBe("agent");
  });

  it("says nothing about an app entrypoint — it can never assert app or edge", () => {
    expect(asEntry("/home/ez/app/src/server.ts")).toBeUndefined();
  });

  it("matches a path segment, not a substring: reagents/ is not agents/", () => {
    expect(asEntry("/home/ez/app/src/reagents/index.ts")).toBeUndefined();
    expect(asEntry("/home/ez/myagents/index.ts")).toBeUndefined();
  });

  it("says nothing when there is no entry path at all (the browser bundle)", () => {
    process.argv = [realArgv[0] ?? "node"];
    expect(entrypointProcessKind()).toBeUndefined();
  });

  it("outranks EZ_PROCESS_KIND exactly as a declaration does", () => {
    // resolveEnv takes the proven kind explicitly so this needs no argv games.
    expect(() =>
      resolveEnv(
        { SUPABASE_URL: PROD_URL, EZ_PROCESS_KIND: "app" },
        { kind: "agent", source: "entrypoint" },
      ),
    ).toThrow(/contradicts agent, established by the entrypoint path/);
  });

  it("yields to an explicit declaration, which is the more specific statement", () => {
    process.argv = [realArgv[0] ?? "node", "/home/ez/app/agents/run.ts"];
    declareProcessKind("agent", "agents/agent-process.ts");
    expect(provenProcessKind()).toEqual({ kind: "agent", source: "declared" });
  });
});

// ---------------------------------------------------------------------------
// The memo — the same bypass shape Gemini found on the env vars, one field over
// ---------------------------------------------------------------------------

describe("getEnv memoisation must not outlive the declaration either", () => {
  it("re-resolves when a declaration lands after a verdict was cached", () => {
    // Startup resolves as an app, before any agent module has been imported.
    setEnv({ SUPABASE_URL: PROD_URL, EZ_PROCESS_KIND: "app" });
    expect(getEnv().kind).toBe("app");

    // An agent module is now imported. Nothing calls resetEnvCache() — production
    // code has no reason to, so a test that reset here could not see the bug.
    declareProcessKind("agent", "agents/agent-process.ts");

    expect(() => getEnv()).toThrow(KillSwitchTrip);
  });

  it("re-resolves when a declaration lands and the variable was never set", () => {
    setEnv({ SUPABASE_URL: SCRATCH_URL });
    expect(getEnv().kindSource).toBe("default");
    declareProcessKind("agent", "agents/agent-process.ts");
    expect(getEnv().kindSource).toBe("declared");
  });
});

// ---------------------------------------------------------------------------
// The wiring — importing agent code is what declares, and it really does
// ---------------------------------------------------------------------------

describe("agents/agent-process.ts", () => {
  /**
   * `resetDeclaredProcessKind()` cannot make this case honest on its own: ESM
   * caches modules, so a second `import()` of agent-process.ts never re-runs its
   * top-level `declareProcessKind` call and the test would pass on state left by
   * a sibling file rather than on the import under test.
   *
   * `vi.resetModules()` gives a fresh registry, and the declaration is then read
   * through a fresh process-kind.ts — the same instance the fresh agent-process
   * resolves — so what is asserted is the import doing the work, now.
   */
  it("declares the process an agent on import, with no call at the import site", async () => {
    vi.resetModules();
    const fresh = await import("../packages/config/process-kind.ts");
    expect(fresh.declaredProcessKind()).toBeUndefined();

    await import("../agents/agent-process.ts");

    expect(fresh.declaredProcessKind()).toBe("agent");
    expect(fresh.declaredProcessKindSource()).toBe("agents/agent-process.ts");
  });

  it("is imported by every agent runtime module that could reach a database", async () => {
    // Named explicitly rather than globbed: adding an agent module that can
    // reach a DB and forgetting the import is exactly the gap leg B exists to
    // cover, and this list is where someone notices it in review.
    for (const mod of ["../agents/guardrails.ts", "../agents/actions.ts", "../agents/secrets.ts"]) {
      vi.resetModules();
      const fresh = await import("../packages/config/process-kind.ts");
      await import(mod);
      expect(fresh.declaredProcessKind(), `${mod} must declare`).toBe("agent");
    }
  });
});
