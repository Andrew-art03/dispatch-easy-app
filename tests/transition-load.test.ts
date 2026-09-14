/**
 * EZ-BUILD-01 Slice 6 (ticket 3A) — the state machine, and the four things about
 * `transition_load()` that have to be true in the text before they can be true at runtime.
 *
 * The pure half is exercised directly. The SQL half is parsed, because its two properties that
 * matter — the lock comes before the legality decision, and the update and the event insert are
 * in one transaction — are facts about statement ORDER, which is exactly what a file can be
 * asked about without a database. D-CC-1 still applies to running it.
 *
 * The test that earns its place most is the last one in the second block: the SQL's edge list
 * and the TypeScript's edge list are compared element by element. Two copies of a state machine
 * is a defect waiting for the day someone adds an edge to one of them.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LEGAL_TRANSITIONS,
  LOAD_STATES,
  TERMINAL_STATES,
  type LoadState,
  allEdges,
  canTransition,
  isLoadState,
  transitionEventType,
} from "../packages/domain/loadStateMachine.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(`${REPO_ROOT}${rel}`, "utf8");

const SQL = read("supabase/migrations/0005_transition_load.sql");
const CODE = SQL.replace(/--[^\n]*/g, "");
const at = (needle: string) => {
  const i = CODE.indexOf(needle);
  return i === -1 ? Number.POSITIVE_INFINITY : i;
};

describe("the states are the frozen schema's, and nothing has been added", () => {
  it("LOAD_STATES matches the load_state enum exactly, in order", () => {
    const schema = read("supabase/schema.sql");
    const body = schema.slice(schema.indexOf("create type load_state as enum ("));
    const declared = [...body.slice(0, body.indexOf(");")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(declared).toEqual([...LOAD_STATES]);
  });

  it("isLoadState refuses anything that is not one of them", () => {
    expect(isLoadState("booked")).toBe(true);
    expect(isLoadState("BOOKED")).toBe(false);
    expect(isLoadState("cancelled")).toBe(false);
    expect(isLoadState(null)).toBe(false);
    expect(isLoadState(7)).toBe(false);
  });
});

describe("the legal edges, and the one copy of them", () => {
  /** `from>to` pairs as the migration declares them. */
  const sqlEdges = (): string[] => {
    const start = CODE.indexOf("load_legal_transitions()");
    const body = CODE.slice(start, CODE.indexOf("$fn$;", start));
    return [...body.matchAll(/'([a-z_]+>[a-z_]+)'/g)].map((m) => m[1] ?? "").sort();
  };

  it("the migration and packages/domain agree edge for edge", () => {
    // Two copies of a state machine is a defect waiting for the day someone adds an edge to
    // one of them. This is the test that makes the convenience copy safe to keep.
    const fromTs = allEdges()
      .map(([f, t]) => `${f}>${t}`)
      .sort();
    expect(sqlEdges()).toEqual(fromTs);
  });

  it("every edge names two real states", () => {
    for (const pair of sqlEdges()) {
      const [from, to] = pair.split(">") as [LoadState, LoadState];
      expect(isLoadState(from), `${from} is not a load state`).toBe(true);
      expect(isLoadState(to), `${to} is not a load state`).toBe(true);
    }
  });

  it("there is no self-edge, in either copy", () => {
    // `x -> x` is how a double-tap writes a second event for an action that happened once.
    for (const pair of sqlEdges()) {
      const [from, to] = pair.split(">");
      expect(from).not.toBe(to);
    }
    for (const [from, to] of allEdges()) expect(from).not.toBe(to);
  });

  it("learned and rejected are terminal, and are the only terminal states", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(["learned", "rejected"]);
    for (const pair of sqlEdges()) expect(pair.startsWith("learned>")).toBe(false);
    for (const pair of sqlEdges()) expect(pair.startsWith("rejected>")).toBe(false);
  });

  it("every non-terminal state is reachable from candidate_found", () => {
    // A state nothing can reach is a state that will never be tested, and eventually a state
    // somebody writes a handler for that can never run.
    const seen = new Set<LoadState>(["candidate_found"]);
    const queue: LoadState[] = ["candidate_found"];
    while (queue.length > 0) {
      const s = queue.shift() as LoadState;
      for (const next of LEGAL_TRANSITIONS[s]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...LOAD_STATES].sort());
  });

  it("nothing in transit or beyond can be rejected", () => {
    // Once the freight is moving, the outcome is delivered-and-billed or an exception handled
    // outside this machine. Quietly marking a moving load `rejected` loses a real obligation.
    for (const s of ["in_transit", "delivered", "billing_ready", "paid_reconciled"] as const) {
      expect(LEGAL_TRANSITIONS[s]).not.toContain("rejected");
    }
  });

  it("terms can be countered, which is a return to negotiating", () => {
    expect(LEGAL_TRANSITIONS.terms_proposed).toContain("negotiating");
  });
});

describe("canTransition is total, pure and never throws", () => {
  it("accepts the forward spine", () => {
    const spine: [LoadState, LoadState][] = [
      ["candidate_found", "qualified"],
      ["qualified", "pursue_approved"],
      ["pursue_approved", "negotiating"],
      ["negotiating", "terms_proposed"],
      ["terms_proposed", "rate_con_received"],
      ["rate_con_received", "booked"],
      ["booked", "in_transit"],
      ["in_transit", "delivered"],
      ["delivered", "billing_ready"],
      ["billing_ready", "paid_reconciled"],
      ["paid_reconciled", "learned"],
    ];
    for (const [from, to] of spine) expect(canTransition(from, to), `${from} -> ${to}`).toEqual({ ok: true });
  });

  it("refuses a skipped step, which is the ordinary illegal transition", () => {
    const r = canTransition("candidate_found", "booked");
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "illegal" });
    // The message names where the load CAN go, so a refusal is actionable rather than just a no.
    expect((r as { message: string }).message).toContain("qualified");
  });

  it("refuses a backward step", () => {
    expect(canTransition("delivered", "in_transit").ok).toBe(false);
  });

  it("refuses a self-transition — the concurrent double-tap, decided in one place", () => {
    for (const s of LOAD_STATES) expect(canTransition(s, s).ok).toBe(false);
  });

  it("refuses anything out of a terminal state, with a reason that says so", () => {
    expect(canTransition("learned", "billing_ready")).toMatchObject({ ok: false, reason: "terminal" });
    expect(canTransition("rejected", "qualified")).toMatchObject({ ok: false, reason: "terminal" });
  });

  it("refuses an unknown state rather than throwing on it", () => {
    // A caller that has to wrap a legality check in try/catch will eventually catch something
    // it did not mean to.
    expect(canTransition("cancelled", "booked")).toMatchObject({ ok: false, reason: "unknown_from" });
    expect(canTransition("booked", "shipped")).toMatchObject({ ok: false, reason: "unknown_to" });
    expect(() => canTransition(undefined, null)).not.toThrow();
  });

  it("is pure: the same arguments give the same answer, and nothing is mutated", () => {
    const before = JSON.stringify(LEGAL_TRANSITIONS);
    const a = canTransition("booked", "in_transit");
    const b = canTransition("booked", "in_transit");
    expect(a).toEqual(b);
    expect(JSON.stringify(LEGAL_TRANSITIONS)).toBe(before);
  });

  it("the event type has one shape, so every state change is findable by one prefix", () => {
    expect(transitionEventType("booked")).toBe("state.booked");
    for (const s of LOAD_STATES) expect(transitionEventType(s).startsWith("state.")).toBe(true);
  });
});

describe("0005: lock, verify, update, event — in that order, in one transaction", () => {
  it("the row is locked BEFORE the legality decision", () => {
    // Deciding first is deciding on a value that may already be stale by the time the update
    // runs. This ordering is the whole reason a concurrent double-transition writes one event.
    expect(at("for update")).toBeLessThan(at("is not a legal transition"));
  });

  it("the lock is a real `for update`, not a plain select", () => {
    expect(CODE).toMatch(/select \* into v_load from load\s+where id = p_load and org_id = v_org for update;/);
  });

  it("the legality check happens before the update, and the update before the event", () => {
    expect(at("is not a legal transition")).toBeLessThan(at("update load set state = p_to"));
    expect(at("update load set state = p_to")).toBeLessThan(at("insert into event"));
  });

  it("there is no commit between the update and the event insert", () => {
    // A function body is one transaction unless something ends it. If a commit appears between
    // those two statements, an unaudited state change becomes possible — rule 10.
    const between = CODE.slice(at("update load set state = p_to"), at("insert into event"));
    expect(between).not.toMatch(/\bcommit\b/i);
    expect(CODE).not.toMatch(/\bcommit\b/i);
  });

  it("is security definer with a pinned search_path", () => {
    // 0003 revoked `update (state) on load` from authenticated and anon, so a caller's own
    // grants cannot write the column. Definer is how this function is allowed to.
    expect(CODE).toMatch(/function transition_load\([\s\S]*?security definer set search_path = public, pg_temp/);
  });

  it("scopes to the caller's org in the same statement that takes the lock", () => {
    // A row belonging to another org is simply not found, so the caller cannot tell "not yours"
    // from "does not exist".
    expect(CODE).toContain("where id = p_load and org_id = v_org for update");
    expect(CODE).toContain("v_org  uuid := auth.org_id()");
  });

  it("refuses when the identity has no org, rather than transitioning something", () => {
    expect(CODE).toContain("if v_org is null then");
  });

  it("requires a reason, so the audit row can answer the question people actually ask", () => {
    expect(CODE).toMatch(/if p_reason is null or btrim\(p_reason\) = '' then/);
  });

  it("writes the event with from, to, reason and correlation id", () => {
    const insert = CODE.slice(at("insert into event"));
    for (const field of ["'from'", "'to'", "'reason'", "'correlation_id'"]) {
      expect(insert.slice(0, 900)).toContain(field);
    }
    expect(insert.slice(0, 900)).toContain("'state.' || p_to::text");
  });

  it("records the acting human only when the actor IS a human", () => {
    // event.actor_user_id is a foreign key to "user". An agent or a system transition has no
    // user behind it, and filling that column with the session's uid would make the audit log
    // claim a person did something a process did.
    expect(CODE).toContain("case when p_actor = 'human' then auth.uid() else null end");
  });

  it("execute is granted to authenticated and revoked from public and anon", () => {
    expect(CODE).toMatch(/revoke execute on function transition_load\([^)]*\) from public, anon;/);
    expect(CODE).toMatch(/grant execute on function transition_load\([^)]*\) to authenticated;/);
  });

  it("does not weaken RLS or drop a policy, so 1D's guard stays quiet for this one", async () => {
    const { RLS_DANGER } = await import("../scripts/migrate.ts");
    expect(RLS_DANGER.test(SQL)).toBe(false);
  });
});

describe("no generic state PATCH exists anywhere in the repo", () => {
  // SPEC 3A says there must not be one. "We simply won't add one" is an intention, not an
  // invariant, so it is asserted.
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(`${REPO_ROOT}${dir}`)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const rel = `${dir}/${entry}`;
      if (statSync(`${REPO_ROOT}${rel}`).isDirectory()) walk(rel, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(rel);
    }
    return out;
  };
  const routeFiles = () => [...walk("src/routes"), ...walk("supabase/functions")];
  /** Every first-party module, which is the set that matters for "nothing else writes state". */
  const allSourceFiles = () => [
    ...walk("src"),
    ...walk("supabase/functions"),
    ...walk("packages"),
    ...walk("agents"),
  ];

  it("no route handler declares a PATCH at all", () => {
    const files = routeFiles();
    // Not vacuous: if the walk returns nothing, the loop below passes for the wrong reason.
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const src = read(f).replace(/\/\/[^\n]*/g, "");
      expect(src, `${f} declares a PATCH handler`).not.toMatch(/\bPATCH\s*:/);
    }
  });

  it("nothing outside the migration writes load.state", () => {
    // The rail that matters more than the one above: a POST that sets `state` from the body is
    // a generic state PATCH wearing a different verb. Scanned across every first-party module,
    // not just the routes — the front end talks to PostgREST directly today, so `src/**` is
    // exactly where such a write would appear.
    const files = allSourceFiles();
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) {
      const src = read(f).replace(/\/\/[^\n]*/g, "");
      expect(src, `${f} appears to update a load's state directly`).not.toMatch(
        /\.from\(\s*["']load["']\s*\)[\s\S]{0,300}?\.(update|upsert)\(/,
      );
    }
  });

  it("the three existing API stubs are named intents, not a target-state setter", () => {
    // confirm / pursue / skip each mean one thing. A caller cannot ask them for an arbitrary
    // state, which is the property that makes them safe to wire to transition_load() later.
    for (const f of ["src/routes/api/loads.$id.confirm.ts", "src/routes/api/loads.$id.pursue.ts", "src/routes/api/loads.$id.skip.ts"]) {
      const src = read(f);
      expect(src).toMatch(/POST:/);
      expect(src).not.toMatch(/body\.state|params\.state|\bto_state\b/);
    }
  });
});

describe("packages/domain stays pure, and the rail proves it", () => {
  it("the state machine imports nothing at all", () => {
    const src = read("packages/domain/loadStateMachine.ts");
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  it("check:domain is wired into package.json with its self-test", async () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const script = pkg.scripts["check:domain"] ?? "";
    expect(script).toContain("assert-domain-purity.mjs --self-test");
    expect(script).toContain("assert-domain-purity.mjs");
  });

  it("the purity rail goes red on every planted positive", async () => {
    // @ts-expect-error — .mjs rail script, no type declarations.
    const { checkPurity, RULES } = await import("../scripts/assert-domain-purity.mjs");
    const check = checkPurity as (f: { path: string; source: string }[]) => {
      violations: { rule: string }[];
    };
    const planted: [string, string][] = [
      // db-boundary:allow — a planted fixture string handed to checkPurity(), never imported.
      ["no-bare-import", `import { createClient } from "@supabase/supabase-js";`],
      ["no-bare-import", `import Anthropic from "@anthropic-ai/sdk";`],
      ["no-network", `const r = await fetch("https://example.test");`],
      ["no-environment", `const k = process.env.ANTHROPIC_API_KEY;`],
      ["no-clock", `const at = Date.now();`],
      ["no-randomness", `const id = crypto.randomUUID();`],
    ];
    for (const [rule, line] of planted) {
      const { violations } = check([{ path: "planted.ts", source: line }]);
      expect(violations.map((v) => v.rule), line).toContain(rule);
    }
    expect((RULES as { id: string }[]).length).toBeGreaterThanOrEqual(7);
  });

  it("and stays green on a module whose COMMENTS mention every banned thing", () => {
    // A rail that cannot tell a comment from code is a rail that gets disabled by the first
    // person who has to document why something is banned.
    // @ts-expect-error — .mjs rail script, no type declarations.
    return import("../scripts/assert-domain-purity.mjs").then(({ checkPurity }) => {
      const source = `/**\n * Mentions process.env, fetch( and Date.now() in prose.\n */\nexport const x = 1;\n// Math.random() in a line comment too.\n`;
      const { violations } = (checkPurity as (f: { path: string; source: string }[]) => { violations: unknown[] })([
        { path: "clean.ts", source },
      ]);
      expect(violations).toEqual([]);
    });
  });
});
