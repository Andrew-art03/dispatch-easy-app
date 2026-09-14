/**
 * EZ-BUILD-01 Slice 3 (ticket 2B) — the two-account isolation proof, minus the two accounts.
 *
 * The live half is D-CC-1: no driver, no SCRATCH_DB_URL, and rule 49 puts the real project out
 * of reach. `tests/schema/rls.sql` holds the eight live statements — including the three named
 * negatives SPEC 2B asks for — ready for the moment a scratch database exists. This file
 * proves what the migration chain says, which is a different claim and is stated as one.
 *
 * The distinction matters and is worth being blunt about: **this file cannot prove isolation
 * holds.** It proves that every table is forced, that every tenant policy derives org from
 * identity rather than from anything a client sent, and that the three specific holes found
 * while writing 0004 are closed in the text. Whether Postgres then behaves as the text says is
 * what `bun run check:rls:live` answers, and it has not been run.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs rail script, no type declarations; plain JS so bare node can run it.
import { CHAIN, RULES, checkMatrix, foldChain } from "../scripts/assert-rls-matrix.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(`${REPO_ROOT}${rel}`, "utf8");

type Row = {
  table: string;
  policies: number;
  enabled: boolean;
  forced: boolean;
  has_policy: boolean;
  org_scoped: boolean;
  with_check: boolean;
  no_blanket_check: boolean;
};
type Result = { rows: Row[]; gaps: { table: string; rule: string }[]; problems: string[] };

const fold = (files: string[]) =>
  (foldChain as (f: { name: string; sql: string }[]) => Map<string, unknown>)(
    files.map((name) => ({ name, sql: read(name) })),
  );
const check = (files: string[], exemptions: unknown[] = []): Result =>
  (checkMatrix as (t: unknown, e: unknown[]) => Result)(fold(files), exemptions);

const EXEMPTIONS = JSON.parse(read("supabase/rls.exemptions.json")) as unknown[];

/** The 15 tables of the frozen Day-0 schema. Named, not counted — a count hides a swap. */
const FROZEN_15 = [
  "org", "user", "truck", "driver", "facility", "broker", "load", "stop",
  "deal", "document", "score", "event", "hunt", "call", "ledger_line",
] as const;

/** The 7 that 0003 adds. 22 in total after the chain. */
const FROM_0003 = [
  "idempotency", "agent_call", "system_flag", "system_flag_event", "budget_use", "approval", "job",
] as const;

describe("FORCE ROW LEVEL SECURITY: the before and after across all 15 tables", () => {
  // This is the whole point of 2B, so it is measured rather than asserted from the diff.
  const before = check(["supabase/migrations/0001_baseline.sql"]);
  const after = check(CHAIN as string[], EXEMPTIONS);

  it("BEFORE — 0001 enabled RLS on all 15 and forced none of them", () => {
    const rows = before.rows.filter((r) => (FROZEN_15 as readonly string[]).includes(r.table));
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.enabled === true)).toBe(true);
    expect(rows.filter((r) => r.forced === true)).toEqual([]);
    // Which is not a nitpick: ENABLE alone exempts the table owner — the role migrations run
    // as — from every policy on the table.
  });

  it("AFTER — all 22 tables in the chain are enabled AND forced", () => {
    expect(after.rows).toHaveLength(22);
    for (const t of [...FROZEN_15, ...FROM_0003]) {
      const row = after.rows.find((r) => r.table === t);
      expect(row, `${t} is missing from the chain`).toBeDefined();
      expect(row?.enabled, `${t} is not ENABLED`).toBe(true);
      expect(row?.forced, `${t} is not FORCED`).toBe(true);
    }
  });

  it("and the chain has exactly the 22 tables it should, with nothing invented", () => {
    // The first run of this rail credited `anon`, `authenticated` and `service_role` as
    // unprotected tables, because 0003's GATE 1 loops over those three ROLE names and the
    // parser could not tell a role loop from a table loop. A matrix that invents tables is a
    // matrix nobody will read twice.
    expect(after.rows.map((r) => r.table).sort()).toEqual([...FROZEN_15, ...FROM_0003].sort());
  });
});

describe("the matrix passes, and the exemptions are named rather than broad", () => {
  it("no gaps once the three reasoned exemptions are applied", () => {
    const { gaps, problems } = check(CHAIN as string[], EXEMPTIONS);
    expect(problems).toEqual([]);
    expect(gaps).toEqual([]);
  });

  it("exactly three gaps without them, so the pass is the check and not the list", () => {
    const { gaps } = check(CHAIN as string[], []);
    expect(gaps.map((g) => `${g.table}:${g.rule}`).sort()).toEqual([
      "org:no_blanket_check",
      "system_flag:org_scoped",
      "system_flag_event:org_scoped",
    ]);
  });

  it("CHAIN covers every migration that creates a table or a policy", () => {
    // The gap this closes: scripts/assert-rls-matrix.mjs folds a HARD-CODED list of migrations.
    // A later migration that adds a table or a policy and is not added to that list escapes the
    // matrix entirely — and the matrix still prints OK, which is the worst way to miss one.
    // Noticed while writing 0005 (Slice 6), which creates neither and so is legitimately absent.
    const dir = `${REPO_ROOT}supabase/migrations`;
    const relevant = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => {
        const sql = read(`supabase/migrations/${f}`).replace(/--[^\n]*/g, "");
        return /create table\s+/i.test(sql) || /create policy\s+/i.test(sql);
      })
      .map((f) => `supabase/migrations/${f}`)
      .sort();
    expect([...(CHAIN as string[])].sort()).toEqual(relevant);
  });

  it("every exemption names a real table, a real rule and a reason worth reading", () => {
    const list = EXEMPTIONS as { table: string; rule: string; reason: string }[];
    const tables = new Set(check(CHAIN as string[], []).rows.map((r) => r.table));
    for (const e of list) {
      expect(tables.has(e.table), `${e.table} is not in the chain`).toBe(true);
      expect(RULES).toContain(e.rule);
      expect(e.reason.length).toBeGreaterThan(80);
    }
  });
});

describe("SPEC 2B's shape: tenant comes from identity, never from the request", () => {
  const sql = read("supabase/migrations/0004_rls_force_and_org_id.sql").replace(/--[^\n]*/g, "");

  it("auth.org_id() is security definer with search_path pinned to public, pg_temp", () => {
    // Without definer the lookup is blocked by the user table's own RLS and recurses; without
    // the pinned search_path a caller can shadow `public`. Both reviewers asked for this.
    const fn = sql.slice(sql.indexOf("function auth.org_id()"), sql.indexOf("function auth.org_id()") + 400);
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = public, pg_temp");
    expect(fn).toContain("stable");
  });

  it("there is one implementation: current_org_id() delegates rather than duplicating", () => {
    const start = sql.indexOf("function current_org_id()");
    // To the end of THAT function body, not a fixed window — a fixed window ran into the next
    // function and read its user-table lookup as this one's.
    const fn = sql.slice(start, sql.indexOf("$fn$;", start));
    expect(fn).toContain("select auth.org_id()");
    // Two functions that each read the user table can drift; one that calls the other cannot.
    expect(fn).not.toMatch(/from public\."user"/);
  });

  it("no policy anywhere in the chain reads a client-supplied value", () => {
    // current_setting / a JWT claim / a request header is a value the caller sent. A boundary
    // built on one is not a boundary.
    for (const file of CHAIN as string[]) {
      const body = read(file).replace(/--[^\n]*/g, "");
      for (const m of body.matchAll(/create policy[\s\S]*?;/gi)) {
        expect(m[0]).not.toMatch(/current_setting|request\.jwt|auth\.jwt\(\)\s*->/i);
      }
    }
  });

  it("the user table's own policies key off auth.uid(), never auth.org_id(), or they recurse", () => {
    // SPEC 2B calls this out explicitly. user_self_org is a SELECT-only policy, which is the
    // one place org scoping on this table is safe.
    expect(sql).toMatch(/create policy user_self_row on "user" for select\s*\n?\s*using \(id = auth\.uid\(\)\)/);
    expect(sql).toMatch(/create policy user_self_update on "user" for update\s*\n?\s*using \(id = auth\.uid\(\)\) with check \(id = auth\.uid\(\)\)/);
  });
});

describe("O-13: a first login could join any tenant, and now cannot", () => {
  const sql = read("supabase/migrations/0004_rls_force_and_org_id.sql").replace(/--[^\n]*/g, "");
  const baseline = read("supabase/migrations/0001_baseline.sql").replace(/--[^\n]*/g, "");

  it("0001's user_self_row constrained WHICH row, and said nothing about org_id", () => {
    // The hole, pinned so the finding cannot be argued about later: this is what shipped.
    expect(baseline).toMatch(
      /create policy user_self_row on "user" for all using \(id = auth\.uid\(\)\) with check \(id = auth\.uid\(\)\)/,
    );
    expect(baseline).not.toContain("org_has_no_users");
  });

  it("0003's immutability trigger does not cover it, because that guards UPDATE", () => {
    const m0003 = read("supabase/migrations/0003_hardening_and_runtime.sql");
    expect(m0003).toMatch(/before update of org_id on "user"/);
    expect(m0003).not.toMatch(/before insert[\s\S]{0,40}on "user"/);
  });

  it("a self-insert is now allowed only into an org with no users yet", () => {
    expect(sql).toMatch(
      /create policy user_bootstrap_insert on "user" for insert\s*\n?\s*with check \(id = auth\.uid\(\) and org_has_no_users\(org_id\)\)/,
    );
  });

  it("org_has_no_users is security definer, or asking the question re-enters the policy", () => {
    const fn = sql.slice(sql.indexOf("function org_has_no_users"), sql.indexOf("function org_has_no_users") + 400);
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = public, pg_temp");
  });
});

describe("the live proof exists and is honest about not having run", () => {
  const rls = read("tests/schema/rls.sql");

  it("carries the three named negatives SPEC 2B asks for", () => {
    expect(rls).toContain("FORGED TENANT ACCEPTED");
    expect(rls).toContain("CROSS-TENANT READ");
    expect(rls).toContain("O-13 OPEN");
  });

  it("a cross-tenant select is asserted to return ZERO ROWS, not to raise", () => {
    // An error tells the caller the row exists. Zero rows tells them nothing, which is the
    // whole difference between a hidden row and a leaked one.
    expect(rls).toMatch(/select count\(\*\) into seen from load where org_id = org_b/);
    expect(rls).toMatch(/if seen <> 0 then/);
  });

  it("every statement rolls back, so the proof leaves no rows behind", () => {
    const blocks = rls.match(/do \$\$[\s\S]*?end \$\$;/g) ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const b of blocks) expect(b).toContain("rollback;");
  });

  it("is wired to a command, and the command counts its statements", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:rls:live"] ?? "").toBe("node scripts/check-schema-live.mjs tests/schema/rls.sql 8");
    // The count is mandatory in the runner: a merge that drops a statement fails rather than
    // reporting green on the ones that survived.
    const statements = rls.split(/^\s*;;\s*$/m).map((c) => c.replace(/--[^\n]*/g, "").trim()).filter(Boolean);
    expect(statements).toHaveLength(8);
  });

  it("invariant 3 is now satisfiable, and was not before 0004", () => {
    const inv = read("tests/schema/invariants.sql");
    expect(inv).toContain("auth.org_id()");
    // The two platform tables are excluded by name, with the same reason as the other two
    // exemption lists, rather than the invariant being loosened for everyone.
    expect(inv).toContain("t.tablename not in ('system_flag','system_flag_event')");
    expect(read("supabase/migrations/0001_baseline.sql")).not.toContain("auth.org_id()");
  });
});

describe("0004 is expected to trip 1D's RLS guard, and that is the guard working", () => {
  it("it does contain DROP POLICY, so scripts/migrate.ts will demand explicit approval", async () => {
    const { RLS_DANGER } = await import("../scripts/migrate.ts");
    const sql = read("supabase/migrations/0004_rls_force_and_org_id.sql");
    // Unlike 0003, which must NOT trip it. A migration that rewrites every tenant boundary in
    // the database should require a human to say so out loud — that is what
    // EZ_RLS_CHANGE_APPROVED is for, and routing around it would defeat 1D.
    expect(RLS_DANGER.test(sql)).toBe(true);
    expect(RLS_DANGER.test(read("supabase/migrations/0003_hardening_and_runtime.sql"))).toBe(false);
  });

  it("and it says so in its own header, so the reader is not surprised at apply time", () => {
    expect(read("supabase/migrations/0004_rls_force_and_org_id.sql")).toContain("EZ_RLS_CHANGE_APPROVED");
  });
});
