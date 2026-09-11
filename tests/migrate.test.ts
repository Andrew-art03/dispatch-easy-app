/**
 * SPEC 1D, static half — every guard in scripts/migrate.ts is proven on a
 * PLANTED POSITIVE, in the spec's order, with no database anywhere.
 *
 * preflight() is pure: argv, env, today and the migration files are arguments,
 * so each guard can be tripped deliberately and the failure asserted by name.
 * The one guard that consults the environment for real is assertNotProd(), which
 * reads 1B's classifier via process.env — driven here with the same setEnv()
 * pattern tests/db-boundary.test.ts uses, so the prod refusal is the REAL
 * classifier saying no, not a mock.
 */
import { afterEach, describe, expect, it } from "vitest";

import { resetEnvCache } from "../packages/config/env.ts";
import { KillSwitchTrip } from "../packages/config/kill-switch.ts";
import { DESTRUCTIVE_FLAG, RLS_DANGER, isoToday, preflight, type MigrationFile } from "../scripts/migrate.ts";

const SCRATCH_REF = "krwcnieffeasjczkwrlz";
const PROD_REF = "efeaylkqgqhobookcqby";
const TODAY = "2026-09-11";

/** Every variable the classifier reads. Cleared between cases. */
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

function setTarget(ref: string) {
  for (const k of MANAGED) delete process.env[k];
  process.env["SUPABASE_URL"] = `https://${ref}.supabase.co`;
  resetEnvCache();
}

afterEach(() => {
  for (const k of MANAGED) delete process.env[k];
  resetEnvCache();
});

const clean: MigrationFile[] = [
  { name: "0001_baseline.sql", sql: "create table t (id uuid primary key, org_id uuid not null);" },
  { name: "0002_add_index.sql", sql: "create index on t (org_id);" },
];

/** A fully valid run: scratch target, dated handshake, no prod-shaped secret, clean files. */
function goodEnv(): Record<string, string | undefined> {
  return { EZ_MIGRATE_OK: `scratch-${TODAY}`, SCRATCH_SERVICE_ROLE: "sb_x" };
}

describe("1D migrate wrapper — guard 1: destructive flags trip the kill switch before anything else", () => {
  it.each(["--reset", "reset", "--force", "push --force", "--shadow", "--RESET"])("%s", (flag) => {
    setTarget(SCRATCH_REF);
    let err: unknown;
    try {
      preflight({ argv: ["--to", "0002", flag], env: goodEnv(), today: TODAY, files: clean });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KillSwitchTrip);
    expect((err as KillSwitchTrip).reason).toBe("destructive");
  });

  it("fires even when every OTHER guard would fail too — it is checked first, so nothing else runs", () => {
    setTarget(PROD_REF); // would also trip prod_target
    let err: unknown;
    try {
      preflight({ argv: ["--reset"], env: {}, today: TODAY, files: clean }); // no handshake either
    } catch (e) {
      err = e;
    }
    expect((err as KillSwitchTrip).reason).toBe("destructive");
  });

  it("the flag pattern is what the spec names, and nothing wider (a migration called 0003_reset_password_tokens.sql is a FILE, not a flag)", () => {
    expect(DESTRUCTIVE_FLAG.test("--to 0003")).toBe(false);
    expect(DESTRUCTIVE_FLAG.test("--reset")).toBe(true);
    setTarget(SCRATCH_REF);
    const files = [...clean, { name: "0003_reset_password_tokens.sql", sql: "create table pw (id uuid, org_id uuid);" }];
    expect(() => preflight({ argv: [], env: goodEnv(), today: TODAY, files })).not.toThrow();
  });
});

describe("1D migrate wrapper — guard 2: never against prod, decided by 1B's real classifier", () => {
  it("trips prod_target when the configured target is the prod project", () => {
    setTarget(PROD_REF);
    let err: unknown;
    try {
      preflight({ argv: [], env: goodEnv(), today: TODAY, files: clean });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KillSwitchTrip);
    expect((err as KillSwitchTrip).reason).toBe("prod_target");
    expect((err as Error).message).toContain("migrate");
  });

  it("passes for the scratch project", () => {
    setTarget(SCRATCH_REF);
    expect(() => preflight({ argv: [], env: goodEnv(), today: TODAY, files: clean })).not.toThrow();
  });
});

describe("1D migrate wrapper — guard 3: the same-day EZ_MIGRATE_OK handshake", () => {
  it("throws when the handshake is missing, naming the exact value to set", () => {
    setTarget(SCRATCH_REF);
    expect(() => preflight({ argv: [], env: { ...goodEnv(), EZ_MIGRATE_OK: undefined }, today: TODAY, files: clean })).toThrow(
      /EZ_MIGRATE_OK=scratch-2026-09-11/,
    );
  });

  it("throws on yesterday's value — a copied handshake does not carry over", () => {
    setTarget(SCRATCH_REF);
    expect(() =>
      preflight({ argv: [], env: { ...goodEnv(), EZ_MIGRATE_OK: "scratch-2026-09-10" }, today: TODAY, files: clean }),
    ).toThrow(/EZ_MIGRATE_OK=scratch-2026-09-11/);
  });

  it("throws on a prod-shaped handshake even with the right date", () => {
    setTarget(SCRATCH_REF);
    expect(() =>
      preflight({ argv: [], env: { ...goodEnv(), EZ_MIGRATE_OK: `prod-${TODAY}` }, today: TODAY, files: clean }),
    ).toThrow(/EZ_MIGRATE_OK=scratch-/);
  });

  it("isoToday() produces the format the handshake expects", () => {
    expect(isoToday(new Date("2026-09-11T23:59:59Z"))).toBe("2026-09-11");
  });
});

describe("1D migrate wrapper — guard 4: a var named SUPABASE_SERVICE_ROLE must not even be present", () => {
  it("throws when it is set, even to an empty string — presence is the violation", () => {
    setTarget(SCRATCH_REF);
    for (const value of ["sb_secret_xyz", ""]) {
      expect(() =>
        preflight({ argv: [], env: { ...goodEnv(), SUPABASE_SERVICE_ROLE: value }, today: TODAY, files: clean }),
      ).toThrow(/never run migrations with a var named SUPABASE_SERVICE_ROLE/);
    }
  });

  it("SCRATCH_SERVICE_ROLE is the accepted name", () => {
    setTarget(SCRATCH_REF);
    expect(() => preflight({ argv: [], env: goodEnv(), today: TODAY, files: clean })).not.toThrow();
  });
});

describe("1D migrate wrapper — guard 5: a migration that weakens RLS needs explicit approval, and is named", () => {
  const planted: MigrationFile[] = [
    ...clean,
    { name: "0003_loosen.sql", sql: "alter table t DISABLE ROW LEVEL SECURITY;" },
  ];

  it.each([
    ["DISABLE ROW LEVEL SECURITY", "alter table t disable row level security;"],
    ["DROP POLICY", "drop policy t_org on t;"],
    ["NO FORCE ROW LEVEL SECURITY", "alter table t no force row level security;"],
  ])("refuses %s without EZ_RLS_CHANGE_APPROVED and names the file", (_label, sql) => {
    setTarget(SCRATCH_REF);
    const files = [...clean, { name: "0003_loosen.sql", sql }];
    expect(() => preflight({ argv: [], env: goodEnv(), today: TODAY, files })).toThrow(/0003_loosen\.sql touches RLS/);
    expect(RLS_DANGER.test(sql)).toBe(true);
  });

  it("passes the same file once EZ_RLS_CHANGE_APPROVED is set (the label + Andrew's review, made visible)", () => {
    setTarget(SCRATCH_REF);
    expect(() =>
      preflight({ argv: [], env: { ...goodEnv(), EZ_RLS_CHANGE_APPROVED: "1" }, today: TODAY, files: planted }),
    ).not.toThrow();
  });

  it("a dangerous file BEYOND --to is not pending and does not block an earlier migration", () => {
    setTarget(SCRATCH_REF);
    const r = preflight({ argv: ["--to", "0002"], env: goodEnv(), today: TODAY, files: planted });
    expect(r.pending.map((f) => f.name)).toEqual(["0001_baseline.sql", "0002_add_index.sql"]);
  });
});

describe("1D migrate wrapper — file discipline", () => {
  it("rejects a file that is not NNNN_snake_case.sql", () => {
    setTarget(SCRATCH_REF);
    const files = [...clean, { name: "hotfix.sql", sql: "select 1;" }];
    expect(() => preflight({ argv: [], env: goodEnv(), today: TODAY, files })).toThrow(/NNNN_snake_case\.sql/);
  });

  it("orders pending files by number regardless of input order", () => {
    setTarget(SCRATCH_REF);
    const r = preflight({ argv: [], env: goodEnv(), today: TODAY, files: [clean[1]!, clean[0]!] });
    expect(r.pending.map((f) => f.name)).toEqual(["0001_baseline.sql", "0002_add_index.sql"]);
  });

  it("rejects a malformed --to", () => {
    setTarget(SCRATCH_REF);
    expect(() => preflight({ argv: ["--to", "3"], env: goodEnv(), today: TODAY, files: clean })).toThrow(/four-digit/);
  });
});
