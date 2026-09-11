/**
 * scripts/migrate.ts — the ONLY way migrations run in this repo (SPEC 1D).
 *
 *   bun run migrate -- --to 0003
 *
 * Never "reset", "push --force", "shadow". Migrations are files, forward-only,
 * human-run, one per PR (CLAUDE.md rule 28). Prod migrations are run by Andrew
 * in the dashboard, never from here (rule 49) — 1B's classifier refuses prod
 * structurally, not by convention (rule 40).
 *
 * TWO PHASES, DELIBERATELY SEPARATED.
 *   preflight()  — pure. Takes argv, env, today's date and the migration files
 *                  as ARGUMENTS and throws on the first violated guard, in the
 *                  spec's order. No filesystem, no network, no process.env
 *                  inside. That is what makes every guard provable in vitest
 *                  with a planted positive, and what guarantees every guard runs
 *                  BEFORE any connection is even attempted.
 *   apply()      — the only place a database is touched. The Postgres driver is
 *                  imported lazily HERE, after preflight, so a guard failure can
 *                  never be preceded by a connection. No driver is installed on
 *                  this branch (rule 30: nothing is added until a human reads
 *                  its source), so apply() fails closed with a clear message —
 *                  the live half waits on that decision and on the scratch
 *                  credential parked with Andrew.
 *
 * Rule 6: this file never echoes a connection string. Errors name variables and
 * files, never values.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assertNotProd } from "../packages/config/db.ts";
import { killSwitchTrip } from "../packages/config/kill-switch.ts";

export interface MigrationFile {
  /** e.g. "0001_baseline.sql" */
  readonly name: string;
  readonly sql: string;
}

export interface PreflightInput {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** "YYYY-MM-DD" — passed in so the rule is testable on any day. */
  readonly today: string;
  readonly files: readonly MigrationFile[];
}

export interface PreflightResult {
  /** Files that will be applied, in order, after every guard has passed. */
  readonly pending: readonly MigrationFile[];
  readonly to: string | undefined;
}

/** Anything that would let a migration weaken RLS needs an explicit, visible approval. */
export const RLS_DANGER = /DISABLE ROW LEVEL SECURITY|DROP POLICY|NO FORCE ROW LEVEL SECURITY/i;

/** rule 47 / doc 24: the `db reset against the wrong project` incident class. */
export const DESTRUCTIVE_FLAG = /reset|force|shadow/i;

const MIGRATION_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** ISO date for the EZ_MIGRATE_OK handshake. Exported so tests and the CLI agree on the format. */
export function isoToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Every guard, in the spec's order. Throws on the first failure. Pure.
 */
export function preflight(input: PreflightInput): PreflightResult {
  const { argv, env, today, files } = input;

  // 1. Destructive flags trip the kill switch — not an ordinary error.
  if (DESTRUCTIVE_FLAG.test(argv.join(" "))) {
    killSwitchTrip("destructive", "migration flag: reset/force/shadow is never run from this repo");
  }

  // 2. Never against prod. 1B's classifier decides what the target IS; a label never does.
  assertNotProd("migrate");

  // 3. Same-day handshake. A stale or copied value from yesterday does not work.
  const expected = `scratch-${today}`;
  if (env["EZ_MIGRATE_OK"] !== expected) {
    throw new Error(`set EZ_MIGRATE_OK=${expected} for today (rule 28: migrations are a deliberate, dated act)`);
  }

  // 4. The prod-shaped secret name must not even be present. CI uses SCRATCH_SERVICE_ROLE.
  if (env["SUPABASE_SERVICE_ROLE"] !== undefined) {
    throw new Error(
      "never run migrations with a var named SUPABASE_SERVICE_ROLE present; CI uses SCRATCH_SERVICE_ROLE",
    );
  }

  // 5. Files: valid names, ordered, optional --to cut-off, and no RLS weakening without approval.
  for (const f of files) {
    if (!MIGRATION_NAME.test(f.name)) {
      throw new Error(`${f.name}: migration files are NNNN_snake_case.sql`);
    }
  }
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const toIndex = argv.indexOf("--to");
  const to = toIndex >= 0 ? argv[toIndex + 1] : undefined;
  if (toIndex >= 0 && !(to && /^\d{4}$/.test(to))) {
    throw new Error("--to takes a four-digit migration number, e.g. --to 0003");
  }
  const pending = to ? sorted.filter((f) => f.name.slice(0, 4) <= to) : sorted;

  for (const f of pending) {
    if (RLS_DANGER.test(f.sql) && !env["EZ_RLS_CHANGE_APPROVED"]) {
      throw new Error(`${f.name} touches RLS; needs the migration label + Andrew (set EZ_RLS_CHANGE_APPROVED after review)`);
    }
  }

  return { pending, to };
}

/** Read supabase/migrations/*.sql. Only used by the CLI; tests hand preflight() its files directly. */
export function readMigrationFiles(dir = join(process.cwd(), "supabase", "migrations")): MigrationFile[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/**
 * The only place a database is touched. One transaction per file; stop on the
 * first failure. The driver is imported lazily so that nothing above this line
 * can ever be preceded by a connection attempt.
 */
async function apply(pending: readonly MigrationFile[], dbUrlVar: string): Promise<void> {
  if (pending.length === 0) {
    console.log("migrate: nothing pending");
    return;
  }
  // Rule 30: no Postgres driver is a dependency of this repo yet. Until a human
  // has read one and added it, the live half cannot run — and says so, instead
  // of silently doing nothing.
  // Computed specifier on purpose: tsc must not resolve a module that is not a
  // dependency yet, and the whole point is that the import happens at runtime,
  // after every guard, or not at all.
  const driverSpecifier = "postgres";
  let driver: unknown;
  try {
    driver = await import(/* @vite-ignore */ driverSpecifier);
  } catch {
    throw new Error(
      `migrate: every guard passed, but no Postgres driver is installed (rule 30) — the live half is not enabled yet. ` +
        `${pending.length} file(s) would have been applied from ${dbUrlVar}.`,
    );
  }
  void driver; // reached only once a driver has been reviewed and added; the apply loop lands with it.
  throw new Error("migrate: apply loop not yet enabled");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const env = process.env;
  const { pending, to } = preflight({ argv, env, today: isoToday(), files: readMigrationFiles() });
  console.log(`migrate: ${pending.length} pending file(s)${to ? ` up to ${to}` : ""}: ${pending.map((f) => f.name).join(", ")}`);
  await apply(pending, "SCRATCH_DB_URL");
}

const isCli = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/migrate.ts") ?? false;
if (isCli) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exit(1);
  });
}
