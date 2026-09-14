#!/usr/bin/env bun
/**
 * OPT-IN database harness: start a throwaway PostgreSQL, apply the real migration chain to
 * it, run a command against it, tear it down. Reached only through `bun run test:db`.
 *
 *   bun run test:db                      # the whole database suite
 *   bun scripts/with-test-db.ts <cmd...> # anything else, against a fresh cluster
 *
 * WHY IT IS NOT PART OF `bun run test`. Deliberate, and it is the same call Easy Eats made
 * on this machine: `bun run test` must stand up no service, so the 24/784 floor never
 * depends on a database being reachable. A suite that goes red because a port was busy
 * teaches people to ignore red. The floor stays a statement about the code.
 *
 * WHY IT IS NOT DOCKER. There is no Docker on this machine today — Docker Desktop dies at
 * launch because the machine-level ProgramData/ALLUSERSPROFILE variables are empty and the
 * fix needs an elevated shell (D-CC-8). `embedded-postgres` is a real PostgreSQL binary
 * managed by the package manager: no daemon, no container, no administrator. The database
 * under these tests is real Postgres running the real policies; only the platform furniture
 * around it is stood in for (scripts/test-db/supabase-prelude.sql).
 *
 * WHY THE TENANCY TESTS ARE NOT MOCKED. Supabase Auth is a service and may be mocked
 * (BUILD_DEFAULTS §5). Supabase Postgres is not a service to us — it is our schema, and
 * rule 12 says the tenant boundary is proved before real data touches the system. A mocked
 * RLS test proves nothing about RLS.
 *
 * PORT 55433, fixed. 55432 belongs to another build on this PC and is never touched.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const PORT = Number(process.env["TEST_DB_PORT"] ?? 55433);
const PASSWORD = "ez-trucking-test"; // a throwaway cluster on loopback; nothing real is in it
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The chain, in order, exactly as Postgres will see it.
 *
 * The ticket says "0003–0006". Those four cannot be applied on their own: 0003 hardens and
 * 0004 FORCEs RLS on tables that 0001 creates, so 0001 is under them by necessity and is
 * listed rather than assumed. It is the same set `scripts/assert-rls-matrix.mjs` folds
 * (0001, 0003, 0004) plus the two function migrations.
 */
const CHAIN = [
  "supabase/migrations/0001_baseline.sql",
  "supabase/migrations/0003_hardening_and_runtime.sql",
  "supabase/migrations/0004_rls_force_and_org_id.sql",
  "supabase/migrations/0005_transition_load.sql",
  "supabase/migrations/0006_ledger_and_approved_action.sql",
];

const PRELUDE = "scripts/test-db/supabase-prelude.sql";
const EPILOGUE = "scripts/test-db/supabase-epilogue.sql";

/**
 * 0003 is a TEMPLATE, and it says so in its own header: GATE 0 is its first statement and
 * it refuses to run while `{{AUTH_USERS_ID}}` is still a placeholder, because
 * `is_founder()` built on the all-zeroes uid returns false for every human and leaves the
 * rule-37 kill switch permanently unreleasable. The gate is right and it did its job the
 * first time this harness ran.
 *
 * So the harness substitutes a founder uid, and it is a fixed, obviously-synthetic one:
 * this cluster is thrown away at the end of every run, and a stable value means a failing
 * `is_founder()` test names the same uid every time instead of a fresh random one.
 *
 * Exported as a constant rather than inlined because `tests/db/**` needs to know who the
 * founder is to test anything about founder-only paths.
 */
export const TEST_FOUNDER_AUTH_USER_ID = "f0f0f0f0-0000-4000-8000-000000000001";

const TEMPLATE_VARS: Record<string, string> = {
  "{{AUTH_USERS_ID}}": TEST_FOUNDER_AUTH_USER_ID,
};

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * Substitute the template variables and then PROVE none are left.
 *
 * The second half is the point. A migration that grew a new `{{...}}` placeholder would
 * otherwise be applied with the literal braces still in it — Postgres would accept it
 * inside a string literal and the harness would report a green run against a schema
 * carrying a placeholder where a real value belongs. That is exactly the class of defect
 * GATE 0 exists to catch, and the harness must not be the way around it.
 */
function substitute(sql: string, rel: string): string {
  let out = sql;
  for (const [token, value] of Object.entries(TEMPLATE_VARS)) out = out.split(token).join(value);
  const leftover = out.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (leftover) {
    throw new Error(
      `${rel} still contains unsubstituted template variables after substitution: ` +
        `${[...new Set(leftover)].join(", ")}. Add them to TEMPLATE_VARS in ` +
        `scripts/with-test-db.ts deliberately — do not apply a migration with a placeholder in it.`,
    );
  }
  return out;
}

/**
 * PostGIS is not bundled with the embedded binary, and it is not available on this machine
 * at all. Exactly two columns in the whole chain use it — `facility.geo` and
 * `facility.dock_geo`, both `geography(point,4326)` — and no tenancy test reads either.
 *
 * So the harness substitutes `text` for that one type and drops the `create extension`
 * line. Both substitutions are ASSERTED rather than applied hopefully: if the chain ever
 * grows a third PostGIS column, or calls a `ST_*` function, the counts stop matching and
 * this throws instead of quietly running a schema that is not ours. A harness that silently
 * diverges from the real schema is worse than no harness.
 */
const POSTGIS_COLUMN = /geography\(point,4326\)/g;
const POSTGIS_EXTENSION = /^create extension if not exists postgis[^;]*;\s*$/gm;
const EXPECTED_POSTGIS_COLUMNS = 2;

function withoutPostgis(sql: string, rel: string): string {
  const columns = sql.match(POSTGIS_COLUMN)?.length ?? 0;
  const spatialCalls = sql.match(/\bST_[A-Za-z_]+\s*\(/g) ?? [];
  if (spatialCalls.length > 0) {
    throw new Error(
      `${rel} calls PostGIS functions (${[...new Set(spatialCalls)].join(", ")}). ` +
        `The embedded harness has no PostGIS, so this can no longer be stood in for — ` +
        `either the test database needs real PostGIS or the migration needs revisiting.`,
    );
  }
  if (rel.endsWith("0001_baseline.sql") && columns !== EXPECTED_POSTGIS_COLUMNS) {
    throw new Error(
      `${rel} has ${columns} geography(point,4326) columns; the harness was written for ` +
        `${EXPECTED_POSTGIS_COLUMNS} (facility.geo, facility.dock_geo). Check what was added ` +
        `and update scripts/with-test-db.ts deliberately.`,
    );
  }
  return sql.replace(POSTGIS_EXTENSION, "").replace(POSTGIS_COLUMN, "text");
}

function run(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    // One command string with shell:true — on Windows the runner needs a shell either way.
    const child = spawn(argv.join(" "), { stdio: "inherit", shell: true, env });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: bun scripts/with-test-db.ts <command...>");
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), "ez-trucking-testdb-"));
const url = `postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: PASSWORD,
  port: PORT,
  persistent: false,
  // Supabase runs UTF8. Without this, initdb on a Windows host picks the system code page
  // and a broker name or a city with an accent in it fails to insert — a difference between
  // the harness and production that would surface as a mystery, not as an error.
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
  onError: () => {},
});

let exitCode = 1;
try {
  process.stdout.write(`with-test-db: starting PostgreSQL on port ${PORT}\n`);
  await pg.initialise();
  await pg.start();

  const client = pg.getPgClient();
  await client.connect();

  const apply = async (rel: string, transform = false) => {
    const sql = transform ? substitute(withoutPostgis(read(rel), rel), rel) : read(rel);
    try {
      await client.query(sql);
      process.stdout.write(`with-test-db:   applied ${rel}\n`);
    } catch (error) {
      throw new Error(`${rel} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await apply(PRELUDE);
  // The founder's auth.users row has to exist before 0003 references the uid.
  await client.query("insert into auth.users (id, email) values ($1, $2) on conflict do nothing", [
    TEST_FOUNDER_AUTH_USER_ID,
    "founder@ez-trucking.test",
  ]);
  for (const migration of CHAIN) await apply(migration, true);
  await apply(EPILOGUE);

  // Prove the thing the tests are about to rely on, before they rely on it: FORCE row level
  // security is on, and it is on for every table. A harness that applied the chain but
  // landed a table without FORCE would let every isolation test pass against a table the
  // owner can read straight through.
  const { rows } = await client.query<{ n: string }>(
    `select count(*)::text as n from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (c.relrowsecurity = false or c.relforcerowsecurity = false)`,
  );
  if (rows[0]?.n !== "0") {
    throw new Error(`${rows[0]?.n} public tables are missing ENABLE or FORCE row level security`);
  }
  process.stdout.write("with-test-db:   every public table has RLS enabled AND forced\n");

  await client.end();

  exitCode = await run(command, { ...process.env, DATABASE_URL: url, TEST_DB_URL: url });
} catch (error) {
  console.error(`with-test-db: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  try {
    await pg.stop();
  } catch {
    // Already down.
  }
  rmSync(dataDir, { recursive: true, force: true });
}

process.exit(exitCode);
