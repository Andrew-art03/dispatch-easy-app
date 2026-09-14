/**
 * EZ-BUILD-01 Slice 2 (ticket 2C) — migration 0003, asserted without a database.
 *
 * WHY A STATIC TEST AT ALL. The live half — "applies forward on the scratch DB" — cannot run
 * from this session: no Postgres driver is installed (rule 30 says a human reads a package's
 * source before it joins the toolchain, and scripts/migrate.ts fails closed by design), and
 * SCRATCH_DB_URL is parked with Andrew. Rule 49 puts the real project out of reach, so it is
 * not a fallback either. D-CC-1.
 *
 * What that leaves is still worth a great deal, because every defect this migration has
 * already had was visible in the text. O-1 and O-2 were "granted/triggered before defined".
 * O-9 and O-10 were "names a column the frozen schema does not have". All four would have
 * aborted the migration at apply time, and all four are ordering-and-naming facts that a file
 * can be checked for. So this pins them mechanically, and the one thing a static test must
 * never do is imply the apply happened. It did not. See DECISIONS_NEEDED.md D-CC-1.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs rail script, no type declarations; plain JS so bare node can run it.
import { checkSchema } from "../scripts/check-schema-parity.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(`${REPO_ROOT}${rel}`, "utf8");

const SQL = read("supabase/migrations/0003_hardening_and_runtime.sql");
const SCHEMA = read("supabase/schema.sql");

/** SQL with `-- comments` removed, so a commented-out statement never counts as present. */
const CODE = SQL.replace(/--[^\n]*/g, "");

/** Character offset of the first occurrence, or Infinity. Used for ordering assertions. */
const at = (needle: string | RegExp): number => {
  const i = typeof needle === "string" ? CODE.indexOf(needle) : CODE.search(needle);
  return i === -1 ? Number.POSITIVE_INFINITY : i;
};

const NEW_TABLES = [
  "idempotency",
  "agent_call",
  "system_flag",
  "system_flag_event",
  "budget_use",
  "approval",
  "job",
] as const;

describe("O-3: the founder uid is a hard pre-apply gate, not a comment", () => {
  it("GATE 0 is the first statement in the file", () => {
    // If anything runs before it, that thing has already applied by the time the gate
    // raises — and the migration is a transaction precisely so that cannot happen.
    expect(at("$gate0$")).toBeLessThan(at(/create (or replace function|table)/));
  });

  it("still holds an unsubstituted placeholder in git", () => {
    // A real uid committed here would be a live identifier in a public repo, and would also
    // mean the gate had already been defeated for everyone who pulls.
    expect(SQL).toContain("{{AUTH_USERS_ID}}");
    expect(SQL).not.toMatch(/auth\.uid\(\)\s*=\s*'[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it("refuses both a placeholder and the all-zeroes uid", () => {
    expect(CODE).toMatch(/!~\*\s*'\^\[0-9a-f\]\{8\}/);
    expect(CODE).toContain("'00000000-0000-0000-0000-000000000000'");
    expect(CODE.match(/raise exception 'REFUSING TO APPLY 0003/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("is_founder() requires the app_metadata flag as well as the uid", () => {
    // Either alone is forgeable with the service role (Grok, SPEC v3). Both must hold.
    const body = CODE.slice(at("function is_founder()"), at("function is_founder()") + 400);
    expect(body).toContain("auth.uid()");
    expect(body).toContain("ez_founder");
    expect(body).toContain(" and ");
  });
});

describe("O-1 / O-2: nothing is granted or triggered before it is defined", () => {
  it("every helper function is defined before SECTION D grants or revokes on it", () => {
    for (const fn of [
      "raise_immutable",
      "assert_child_org",
      "is_founder",
      "log_system_flag_change",
      "finish_agent_call",
      "consume_approval",
    ]) {
      expect(at(`function ${fn}(`)).toBeLessThan(at(new RegExp(`(revoke|grant) execute on function ${fn}\\b`)));
    }
  });

  it("every trigger's function is defined before the trigger references it", () => {
    for (const fn of ["raise_immutable", "assert_child_org", "log_system_flag_change"]) {
      expect(at(`create or replace function ${fn}(`)).toBeLessThan(at(`execute function ${fn}(`));
    }
  });

  it("execute_approved_action is neither defined nor granted here — O-8 option (ii)", () => {
    // The defect that started this: granting execute on a function whose body was deferred to
    // 3A/6E raises "function does not exist" and rolls the WHOLE migration back. It lands with
    // transition_load(), which is Slice 6. A stub was rejected — rule 33.
    expect(CODE).not.toMatch(/create( or replace)? function execute_approved_action/);
    expect(CODE).not.toMatch(/grant execute on function execute_approved_action/);
  });

  it("transition_load is not pulled into a Group-2 migration either", () => {
    expect(CODE).not.toMatch(/create( or replace)? function transition_load/);
  });
});

describe("O-9 / O-10: every column named here exists in the frozen schema", () => {
  // The class of defect that produced both: writing SQL from the spec's prose instead of from
  // the schema. Neither is catchable by review of the spec, and both abort at apply time.

  it("load has `state`, and has neither `status` nor `exception`", () => {
    expect(SCHEMA).toMatch(/^\s+state load_state not null/m);
    expect(SCHEMA).not.toMatch(/^\s+status /m);
    expect(SCHEMA).not.toMatch(/^\s+exception /m);
  });

  it("the migration revokes update on load(state) and never on a column that does not exist", () => {
    expect(CODE).toMatch(/revoke update \(state\) on load from authenticated, anon;/);
    expect(CODE).not.toMatch(/update \([^)]*\bstatus\b[^)]*\) on load/);
    expect(CODE).not.toMatch(/update \([^)]*\bexception\b[^)]*\) on load/);
  });

  it("ledger_line has `category`, not `kind`, and the business key uses it", () => {
    expect(SCHEMA).toMatch(/^\s+category text not null/m);
    expect(SCHEMA).not.toMatch(/^\s+kind text/m);
    expect(CODE).toContain("ledger_line_business_key on ledger_line (org_id, load_id, category, source_ref)");
  });

  it("the billing tier does not collide with the org.plan column that already exists", () => {
    // schema.sql: `plan text not null default 'standard'` — the automation tier, a different
    // thing. Adding `plan` would abort on a duplicate column; worse, had it not, it would have
    // quietly given one live column two meanings.
    expect(SCHEMA).toMatch(/plan text not null default 'standard'/);
    expect(CODE).toContain("add column plan_tier text not null default 'pilot_free'");
    expect(CODE).not.toMatch(/alter table org add column plan\b/);
  });

  it("source_ref is backfilled per row before NOT NULL, and keeps no default", () => {
    // SPEC said NOT NULL; the draft's `default ''` satisfied that while making the business key
    // collide for every two rows that both mean "no source".
    expect(at("alter table ledger_line add column source_ref text;")).toBeLessThan(
      at("update ledger_line set source_ref"),
    );
    expect(at("update ledger_line set source_ref")).toBeLessThan(
      at("alter column source_ref set not null"),
    );
    expect(CODE).not.toMatch(/source_ref text not null default/);
  });
});

describe("the audit tables cannot be rewritten, by anyone, including service_role", () => {
  it("event is insert-only for all three roles (rule 36)", () => {
    expect(CODE).toMatch(/revoke update, delete on event from authenticated, anon, service_role;/);
  });

  it("agent_call moves off 'pending' only through finish_agent_call", () => {
    expect(CODE).toMatch(/revoke update, delete on agent_call from authenticated, anon, service_role;/);
    const body = CODE.slice(at("function finish_agent_call("));
    expect(body).toContain("security definer");
    // The single-transition guard: a finished row can never be re-finalized.
    expect(body.slice(0, 900)).toMatch(/where id = p_id and status = 'pending'/);
  });

  it("agent_call rows are created pending, so a dead process still leaves a trace", () => {
    expect(CODE).toMatch(/status text not null default 'pending' check \(status in \('pending','done','failed'\)\)/);
  });

  it("an orphaned pending row is swept to 'failed' and never to 'done'", () => {
    const sweep = CODE.slice(at("function sweep_orphaned_agent_calls"));
    expect(sweep.slice(0, 700)).toContain("set status = 'failed'");
    expect(sweep.slice(0, 700)).toContain("'orphaned'");
    expect(sweep.slice(0, 700)).not.toContain("'done'");
  });

  it("the incident timeline has exactly one writer: its trigger", () => {
    expect(CODE).toMatch(/revoke insert, update, delete on system_flag_event from authenticated, anon, service_role;/);
    expect(CODE.slice(at("function log_system_flag_change"), at("function log_system_flag_change") + 900)).toContain(
      "security definer",
    );
  });

  it("a system_flag change with no stated reason is refused (rule 37)", () => {
    const fn = CODE.slice(at("function log_system_flag_change"));
    expect(fn.slice(0, 1200)).toContain("ez.reason");
    expect(fn.slice(0, 1200)).toMatch(/raise exception 'system_flag\.% cannot change without a reason/);
  });
});

describe("the human gate: an approval is single-use, tenant-scoped and terms-bound", () => {
  it("consume_approval checks all four refusal conditions in one statement", () => {
    const fn = CODE.slice(at("function consume_approval("), at("function consume_approval(") + 900);
    expect(fn).toContain("security definer");
    expect(fn).toContain("consumed_at is null"); // already used
    expect(fn).toContain("expires_at > now()"); // expired
    expect(fn).toContain("terms_hash = p_terms_hash"); // drifted terms
    expect(fn).toContain("org_id = current_org_id()"); // wrong tenant
  });

  it("direct UPDATE on approval is revoked, so consume_approval is the only way to consume", () => {
    expect(CODE).toMatch(/revoke update, delete on approval from authenticated, anon, service_role;/);
  });

  it("nobody may call consume_approval directly", () => {
    expect(CODE).toMatch(
      /revoke execute on function consume_approval\(uuid, text, uuid, text\)\s*\n?\s*from public, authenticated, anon, service_role;/,
    );
  });

  it("the ledger is closed to direct inserts from every role", () => {
    expect(CODE).toMatch(/revoke insert on ledger_line from authenticated, anon, service_role;/);
  });

  it("the four approvable actions are constrained by the database, not by a handler", () => {
    expect(CODE).toMatch(/action text not null check \(action in \('send','book','pay','confirm'\)\)/);
  });
});

describe("idempotency is enforced by the primary key, not by handler code", () => {
  it("the PK is (org_id, operation, key) and the row carries a request_hash", () => {
    expect(CODE).toContain("primary key (org_id, operation, key)");
    expect(CODE).toMatch(/request_hash text not null/);
  });

  it("a stored response is capped at 64 KB", () => {
    expect(CODE).toMatch(/octet_length\(response::text\) <= 65536/);
  });

  it("there is an index on created_at and a purge for the 7-day rule", () => {
    expect(CODE).toContain("idempotency_created_at_idx on idempotency (created_at)");
    expect(CODE.slice(at("function purge_idempotency"), at("function purge_idempotency") + 500)).toContain(
      "interval '7 days'",
    );
  });
});

describe("parent/child tenant consistency (SPEC 2C section 8)", () => {
  it("all three children of load are guarded", () => {
    for (const child of ["stop", "deal", "document"]) {
      expect(CODE).toMatch(new RegExp(`on ${child}\\s*\\n?\\s*for each row execute function assert_child_org\\('load'\\)`));
    }
  });

  it("each guarded child really does have a load_id in the frozen schema", () => {
    // O-11's sibling: the trigger reads <parent>_id off the new row, so that column has to
    // exist on every table the trigger is attached to.
    for (const child of ["stop", "deal", "document"]) {
      const table = SCHEMA.slice(SCHEMA.indexOf(`create table ${child} (`));
      expect(table.slice(0, table.indexOf(");"))).toMatch(/load_id uuid/);
    }
  });

  it("O-11: the parent key is read without dynamic record access", () => {
    expect(CODE).toContain("to_jsonb(new) ->> (parent_table || '_id')");
    expect(CODE).not.toContain("select ($1).");
  });

  it("user.org_id is immutable", () => {
    expect(CODE).toMatch(/create trigger user_org_immutable\s+before update of org_id on "user"/);
  });
});

describe("O-12: the migration names its prerequisites instead of aborting on a typo", () => {
  it("GATE 1 checks the three Supabase roles, auth.uid() and current_org_id()", () => {
    const gate = CODE.slice(at("$gate1$"), at("$gate1$") + 1600);
    expect(gate).toContain("authenticated");
    expect(gate).toContain("service_role");
    expect(gate).toContain("auth.uid()");
    expect(gate).toContain("current_org_id()");
  });

  it("GATE 1 runs before the first CREATE", () => {
    expect(at("$gate1$")).toBeLessThan(at(/create (or replace function|table)/));
  });
});

describe("RLS on the seven tables this migration creates", () => {
  it("every one is ENABLED and FORCED, not merely enabled", () => {
    const loop = CODE.slice(at("$rls$"), at("$rls$") + 900);
    for (const t of NEW_TABLES) expect(loop).toContain(`'${t}'`);
    expect(loop).toContain("enable row level security");
    expect(loop).toContain("force row level security");
  });

  it("every one has at least one policy", () => {
    for (const t of NEW_TABLES) {
      expect(CODE).toMatch(new RegExp(`create policy \\w+ on ${t} for `));
    }
  });

  it("tenant-scoped writes carry a with check, so a forged org_id cannot be inserted", () => {
    // SPEC 2B's named negative: user A writing org_id = B. `using` alone would let the row in
    // and merely hide it afterwards.
    for (const t of ["idempotency", "approval"]) {
      const policy = CODE.slice(at(`on ${t} for all`), at(`on ${t} for all`) + 200);
      expect(policy).toContain("using (org_id = current_org_id())");
      expect(policy).toContain("with check (org_id = current_org_id())");
    }
  });

  it("agent_call is readable by its org and writable by none of them", () => {
    expect(CODE).toMatch(/create policy agent_call_org_read on agent_call for select/);
    expect(CODE).not.toMatch(/create policy \w+ on agent_call for (all|insert|update)/);
  });

  it("the kill switch is visible to every authenticated user and flippable only by the founder", () => {
    // Seeing that it is engaged is the entire point of it; SPEC 2C section 4.
    expect(CODE).toMatch(/create policy flag_read on system_flag for select\s*\n?\s*using \(auth\.role\(\) = 'authenticated'\)/);
    expect(CODE).toMatch(
      /create policy flag_write on system_flag for update\s*\n?\s*using \(is_founder\(\)\) with check \(is_founder\(\)\)/,
    );
  });

  it("policies key off the function that is actually deployed, not one 2B has yet to create", () => {
    // 0001 deployed current_org_id() — security definer, reads the user row, SPEC 2B's shape
    // under another name. Writing policies against auth.org_id() today would abort. 2B moves
    // every policy in the database at once, in a labelled migration: "never a silent swap."
    expect(CODE).toContain("current_org_id()");
    expect(CODE).not.toContain("auth.org_id()");
  });
});

describe("tenant-boundary parity, run over the migration itself", () => {
  const parity = (allowlist: unknown[]) =>
    (
      checkSchema as (
        sql: string,
        a: unknown[],
      ) => { gaps: { table: string; invariant: string }[]; problems: string[]; tables: unknown[] }
    )(SQL, allowlist);

  it("every new table satisfies org_id + ENABLE + FORCE, or has a reasoned exemption", () => {
    const allowlist = JSON.parse(read("supabase/schema.allowlist.0003.json")) as unknown[];
    const { gaps, problems, tables } = parity(allowlist);
    expect(tables).toHaveLength(NEW_TABLES.length);
    expect(problems).toEqual([]);
    expect(gaps).toEqual([]);
  });

  it("and goes red with the exemptions removed, so the pass is not vacuous", () => {
    // The two exemptions are real ones, for two genuinely platform-level tables. This proves
    // the check is what is passing, rather than the allowlist swallowing everything.
    const { gaps } = parity([]);
    expect(gaps.map((g) => `${g.table}:${g.invariant}`).sort()).toEqual([
      "system_flag:org_id",
      "system_flag_event:org_id",
    ]);
  });

  it("`bun run check:schema` actually runs that check, rather than it living only here", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:schema"] ?? "").toContain("0003_hardening_and_runtime.sql");
  });
});

describe("the migration does not weaken anything, and 0001 is untouched", () => {
  it("contains no RLS-weakening statement", () => {
    expect(CODE).not.toMatch(/disable row level security/i);
    expect(CODE).not.toMatch(/drop policy/i);
    expect(CODE).not.toMatch(/no force row level security/i);
  });

  it("passes 1D's own RLS_DANGER guard, tested against the real exported pattern", async () => {
    // Not a re-spelling of the three phrases above: this is the regex scripts/migrate.ts
    // actually gates on, so if 1D tightens it, this test notices instead of the apply doing so.
    const { RLS_DANGER } = await import("../scripts/migrate.ts");
    expect(RLS_DANGER.test(SQL)).toBe(false);
    // And the guard is not vacuous — it still catches the thing it is for.
    expect(RLS_DANGER.test("alter table load disable row level security;")).toBe(true);
  });

  it("contains no destructive or reset-flavoured statement", () => {
    expect(CODE).not.toMatch(/\bdrop (table|schema|database)\b/i);
    expect(CODE).not.toMatch(/\btruncate\b/i);
  });

  it("does not edit the frozen baseline", () => {
    // 0001 IS schema.sql, byte for byte (check:migration-baseline). A change to the schema is
    // a new numbered migration, never an edit to 0001.
    expect(SCHEMA.replace(/\r\n/g, "\n")).toBe(
      read("supabase/migrations/0001_baseline.sql").replace(/\r\n/g, "\n"),
    );
  });

  it("is numbered after the baseline and is the only 0003", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(`${REPO_ROOT}supabase/migrations`).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith("0003")).length).toBe(1);
    expect(files).toContain("0001_baseline.sql");
  });
});
