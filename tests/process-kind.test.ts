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
  declareAgentProcess,
  declaredProcessKind,
  declaredProcessKindSource,
  entrypointProcessKind,
  provenProcessKind,
} from "../packages/config/process-kind.ts";
import { resetDeclaredProcessKind } from "./support/process-kind.ts";

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
    declareAgentProcess("agents/agent-process.ts");
    expect(() => createDb("user")).toThrow(KillSwitchTrip);
    expect(() => createDb("user")).toThrow(/process_kind/);
  });

  it("names both the claim and what overruled it, so the log says what happened", () => {
    setEnv({ SUPABASE_URL: PROD_URL, EZ_PROCESS_KIND: "app" });
    declareAgentProcess("agents/agent-process.ts");
    expect(() => getEnv()).toThrow(/EZ_PROCESS_KIND=app contradicts agent/);
    expect(() => getEnv()).toThrow(/agents\/agent-process\.ts/);
  });

  it("refuses the contradiction against scratch too, not only against prod", () => {
    // The contradiction is about identity, not about the target. A process that
    // cannot say what it is does not get a client of any kind — resolving it as
    // "probably fine, it's only scratch" is how the unknown-is-safe class of bug
    // gets back in (same reasoning as UnknownEnvironment in 1B).
    setEnv({ SUPABASE_URL: SCRATCH_URL, EZ_PROCESS_KIND: "app" });
    declareAgentProcess("agents/agent-process.ts");
    expect(() => getEnv()).toThrow(KillSwitchTrip);
  });

  // The "is symmetric: a declared app cannot be demoted to an agent by the
  // variable either" case that stood here until 1F/N-4 is GONE, and its absence
  // is the fix. It declared `"app"` from a test and called that correct
  // behaviour — which is how the panel found that Leg A was not deny-only at
  // all, with this file blessing it. `app` is no longer declarable; see the
  // N-4 suite at the bottom of this file.

  it("accepts the variable when it agrees with the declaration", () => {
    setEnv({ SUPABASE_URL: SCRATCH_URL, EZ_PROCESS_KIND: "agent" });
    declareAgentProcess("agents/agent-process.ts");
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
    declareAgentProcess("agents/agent-process.ts");
    expect(() => getEnv()).toThrow(UnknownEnvironment);
  });
});

// ---------------------------------------------------------------------------
// The declaration itself
// ---------------------------------------------------------------------------

describe("declareAgentProcess", () => {
  it("starts undeclared, so nothing is claimed by accident", () => {
    expect(declaredProcessKind()).toBeUndefined();
  });

  it("records the first declaration", () => {
    declareAgentProcess("agents/agent-process.ts");
    expect(declaredProcessKind()).toBe("agent");
    expect(provenProcessKind()).toEqual({ kind: "agent", source: "declared" });
  });

  it("is idempotent — several agent modules import agent-process.ts", () => {
    declareAgentProcess("agents/guardrails.ts");
    expect(() => declareAgentProcess("agents/actions.ts")).not.toThrow();
    expect(declaredProcessKind()).toBe("agent");
  });

  it("keeps the ORIGINAL declarer, so a message names what established identity", () => {
    declareAgentProcess("agents/agent-process.ts");
    declareAgentProcess("agents/actions.ts");
    expect(declaredProcessKindSource()).toBe("agents/agent-process.ts");
  });

  // 1F/N-4: the "trips on a contradicting redeclaration" pair that stood here
  // is gone with the parameter that made a contradiction expressible. A guard
  // against an impossible state is a guard nobody maintains correctly, and the
  // two cases were the only thing making `declareProcessKind("app", …)` look
  // like a supported call.
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
    declareAgentProcess("agents/agent-process.ts");
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
    declareAgentProcess("agents/agent-process.ts");

    expect(() => getEnv()).toThrow(KillSwitchTrip);
  });

  it("re-resolves when a declaration lands and the variable was never set", () => {
    setEnv({ SUPABASE_URL: SCRATCH_URL });
    expect(getEnv().kindSource).toBe("default");
    declareAgentProcess("agents/agent-process.ts");
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

// ---------------------------------------------------------------------------
// N-1 — the sanctioned factory must stay usable by the processes it is for
// ---------------------------------------------------------------------------

/**
 * Closing C-2 made `packages/config/db.ts` import `agents/secrets.ts` for the
 * scrubber registry, and `agents/secrets.ts` imports `agents/agent-process.ts`,
 * which calls `declareProcessKind("agent")` at module init. So merely importing
 * the client factory declared the whole process an agent — every app process,
 * every Edge Function, and `scripts/migrate.ts` with it.
 *
 * The consequence is not theoretical. Such a process then has two outcomes and
 * both are wrong: it sets the `EZ_PROCESS_KIND=app` opt-out the docs require and
 * the contradiction kills it, or it leaves the variable alone, resolves as an
 * agent, and rule 40 refuses it the production client it is legitimately allowed
 * to hold. CI was green only because the web app never calls `createDb()` — it
 * uses the unguarded `src/lib/supabase.ts`, which is C-1's actual open defect.
 *
 * `vi.resetModules()` is what makes this honest: ESM caches modules, so without
 * a fresh registry this would read a declaration left behind by a sibling file
 * rather than the import under test.
 */
describe("N-1: importing the client factory is not a declaration", () => {
  it("importing packages/config/db.ts leaves the process undeclared", async () => {
    vi.resetModules();
    const fresh = await import("../packages/config/process-kind.ts");
    expect(fresh.declaredProcessKind()).toBeUndefined();

    await import("../packages/config/db.ts");

    expect(fresh.declaredProcessKind()).toBeUndefined();
  });

  it("importing packages/config/env.ts leaves the process undeclared", async () => {
    vi.resetModules();
    const fresh = await import("../packages/config/process-kind.ts");
    await import("../packages/config/env.ts");
    expect(fresh.declaredProcessKind()).toBeUndefined();
  });

  it("an app process can still build a prod client through the factory", async () => {
    // The end the user actually cares about: this is the whole stated design of
    // 1B — every client comes from createDb() — and N-1 had made it impossible
    // for the one process kind that is allowed a prod target.
    vi.resetModules();
    const { createDb } = await import("../packages/config/db.ts");
    const { resetEnvCache: reset } = await import("../packages/config/env.ts");
    setEnv({
      SUPABASE_URL: PROD_URL,
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_AAAAAAAAAAAAAAAAAAAAAA",
      EZ_PROCESS_KIND: "app",
    });
    reset();
    expect(() => createDb("user")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// N-4 — "both legs are DENY-ONLY" was a comment, not a fact
// ---------------------------------------------------------------------------

/**
 * process-kind.ts:29 claimed "Both legs are DENY-ONLY: they can assert `agent`,
 * never `app` or `edge`". Leg A accepted `"app"` and this very file blessed it.
 *
 * Worse than a stale comment: a declaration SHADOWED Leg B rather than being
 * reconciled with it, so `bun agents/run-triage.ts` resolved `agent` under 1B
 * and under Leg B, but `app` if anything in its import graph declared `"app"`.
 * That is a path where the new code is LESS restrictive than the env-var-only
 * code it replaced, and it is reached through code rather than the environment —
 * which is the one thing C-2's whole design was supposed to rule out.
 */
describe("N-4: the declaration leg can only ever assert agent", () => {
  it("exports no way to declare a kind — declareAgentProcess is the whole API", async () => {
    const mod = await import("../packages/config/process-kind.ts");
    expect(Object.keys(mod)).not.toContain("declareProcessKind");
    expect(typeof (mod as Record<string, unknown>)["declareAgentProcess"]).toBe("function");
  });

  it("does not ship the test reset from production source", async () => {
    // resetDeclaredProcessKind() un-declares an agent process. In production
    // source it is a bypass with a friendly name: call it and rule 40's check
    // stops running. It lives in tests/support/ now.
    const mod = await import("../packages/config/process-kind.ts");
    expect(Object.keys(mod)).not.toContain("resetDeclaredProcessKind");
  });

  it("reports agent when EITHER leg says so, rather than short-circuiting on one", () => {
    // Leg B alone.
    const realArgv = process.argv;
    try {
      process.argv = [realArgv[0] ?? "node", "/home/ez/app/agents/run-triage.ts"];
      expect(provenProcessKind()).toEqual({ kind: "agent", source: "entrypoint" });

      // Both legs. The declaration is the more specific statement, so it names
      // the source — but it can no longer CHANGE the answer, which is the part
      // that was wrong.
      declareAgentProcess("agents/agent-process.ts");
      expect(provenProcessKind()).toEqual({ kind: "agent", source: "declared" });
    } finally {
      process.argv = realArgv;
    }
  });

  it("an agent entrypoint stays an agent whatever else the graph declares", () => {
    const realArgv = process.argv;
    try {
      process.argv = [realArgv[0] ?? "node", "/home/ez/app/agents/run-triage.ts"];
      declareAgentProcess("some-module.ts");
      expect(provenProcessKind()?.kind).toBe("agent");
    } finally {
      process.argv = realArgv;
    }
  });
});

describe("N-4: the entrypoint segment test is case-insensitive", () => {
  const realArgv = process.argv;
  afterEach(() => {
    process.argv = realArgv;
  });

  const asEntry = (path: string) => {
    process.argv = [realArgv[0] ?? "node", path];
    return entrypointProcessKind();
  };

  it("claims agent for a capitalised Agents directory on Windows", () => {
    // This repo lives on Windows and NTFS is case-insensitive: a launcher, a
    // shortcut or a hand-typed path can spell it `Agents\` and reach exactly the
    // same files. `/(^|\/)agents\//` missed it, so the deny leg silently did not
    // apply to the process it was written for.
    const winPath = ["C:", "Users", "AAndew", "AutoDispatch", "ez-app", "Agents", "run-triage.ts"]
      .join(String.fromCharCode(92)); // a real backslash, not an escape sequence
    expect(asEntry(winPath)).toBe("agent");
  });

  it("claims agent for AGENTS/ too", () => {
    expect(asEntry("/home/ez/app/AGENTS/run.ts")).toBe("agent");
  });

  it("still matches a segment, not a substring, in any case", () => {
    // A false positive here is only ever MORE restrictive, but a rule nobody can
    // predict is worse than a rule that is slightly narrow — so the segment
    // requirement survives the case change.
    expect(asEntry("/home/ez/app/src/Reagents/index.ts")).toBeUndefined();
    expect(asEntry("/home/ez/MyAgents/index.ts")).toBeUndefined();
  });
});
