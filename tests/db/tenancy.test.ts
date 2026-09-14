/**
 * EZ-BUILD-02 Slice 1 — the tenant boundary, proved against real PostgreSQL.
 *
 * This is rule 12's guarantee ("no real driver/carrier/broker/document data until the
 * two-account isolation tests pass and are recorded") and rule 4's ("every query is
 * tenant-scoped; RLS is on"). It is the one thing in this build that may never be proved
 * against a mock, because a mocked RLS test proves nothing about RLS — it proves that the
 * mock returns what the test asked it to.
 *
 * WHAT IS REAL HERE AND WHAT IS STOOD IN FOR, stated so nobody has to guess:
 *   REAL — PostgreSQL, the migration chain 0001/0003/0004/0005/0006 exactly as it ships,
 *          every policy, ENABLE and FORCE row level security, `auth.org_id()`,
 *          `org_has_no_users()`, and the O-13 bootstrap policy.
 *   STOOD IN — the platform furniture a bare Postgres lacks: the `auth` schema,
 *          `auth.users`, `auth.uid()` reading the request GUC, and the three Supabase
 *          roles (scripts/test-db/supabase-prelude.sql). Identity is set the way
 *          PostgREST sets it, with `set local role` + `set local request.jwt.claims`.
 *
 * Supabase Auth the SERVICE is not involved and does not need to be: what is under test is
 * what the database does once a uid has been established, and that is precisely the part
 * no mock may stand in for.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const URL = process.env["TEST_DB_URL"] ?? process.env["DATABASE_URL"];

let client: pg.Client;

/** A uuid without pulling in a dependency for it. */
const uuid = () => crypto.randomUUID();

/**
 * Run `fn` as an authenticated end user, the way a request arrives through PostgREST:
 * the `authenticated` role plus a JWT claims GUC carrying the subject. `set local` scopes
 * both to the transaction, so no case can leak identity into the next one.
 *
 * Deliberately NOT a helper that also swallows errors — a permission error and a
 * zero-row result mean completely different things here, and a test that cannot tell
 * them apart is the failure mode this suite exists to avoid.
 */
async function asUser<T>(authUserId: string, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: authUserId, role: "authenticated" }),
    ]);
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

/** Same, but the transaction is kept so the writes survive. */
async function asUserCommitted<T>(authUserId: string, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: authUserId, role: "authenticated" }),
    ]);
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/** Carrier A and carrier B — two tenants that must never see each other. */
const carrierA = { authUserId: uuid(), orgId: "", orgName: "Freedom Trucking LLC" };
const carrierB = { authUserId: uuid(), orgId: "", orgName: "Rival Haulage Inc" };

beforeAll(async () => {
  if (!URL) {
    throw new Error(
      "no TEST_DB_URL. These tests run through `bun run test:db`, which starts the " +
        "cluster for them. Running them directly is not supported on purpose — a database " +
        "test that quietly skips is worse than one that fails.",
    );
  }
  client = new pg.Client({ connectionString: URL });
  await client.connect();

  // The platform would have created these rows when the accounts signed up.
  for (const c of [carrierA, carrierB]) {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      c.authUserId,
      `${c.authUserId}@example.test`,
    ]);
  }
});

afterAll(async () => {
  await client?.end();
});

// ---------------------------------------------------------------------------
// First login — the bootstrap, and O-13
// ---------------------------------------------------------------------------

describe("first login creates exactly one org and one owner, through the policies", () => {
  /**
   * Mirrors `loadOrBootstrapMe()` in src/lib/session.ts exactly: the org id is chosen by
   * the caller and there is no RETURNING. See the regression case at the end of this
   * describe for why — that is the defect this suite found on its first run.
   */
  const signUp = (who: { authUserId: string; orgId: string; orgName: string }) =>
    asUserCommitted(who.authUserId, async () => {
      await client.query("insert into org (id, name) values ($1, $2)", [who.orgId, who.orgName]);
      await client.query("insert into \"user\" (id, org_id, role) values ($1, $2, 'owner')", [
        who.authUserId,
        who.orgId,
      ]);
    });

  it("carrier A signs up and lands in its own org", async () => {
    carrierA.orgId = uuid();
    await signUp(carrierA);
    const { rows } = await asUser(carrierA.authUserId, () =>
      client.query<{ org_id: string }>("select org_id from \"user\" where id = $1", [
        carrierA.authUserId,
      ]),
    );
    expect(rows[0]!.org_id).toBe(carrierA.orgId);
  });

  it("carrier B signs up and lands in a DIFFERENT org", async () => {
    carrierB.orgId = uuid();
    await signUp(carrierB);
    expect(carrierB.orgId).not.toBe(carrierA.orgId);
    const { rows } = await asUser(carrierB.authUserId, () =>
      client.query<{ org_id: string }>("select org_id from \"user\" where id = $1", [
        carrierB.authUserId,
      ]),
    );
    expect(rows[0]!.org_id).toBe(carrierB.orgId);
  });

  /**
   * THE DEFECT THIS SUITE FOUND, pinned so it cannot come back.
   *
   * `loadOrBootstrapMe()` used to do `.insert({name}).select("id").single()`. The insert is
   * fine — `org_bootstrap_insert` is `with check (true)`. The RETURNING is not: Postgres
   * applies the SELECT policy to the new row, `org_self` is `id = auth.org_id()`, and on a
   * first login `auth.org_id()` is NULL because the caller has no `user` row yet. The org
   * was created and then refused to its own creator, so sign-up failed for every new
   * account. Nobody had ever run this path against a real database.
   */
  it("REGRESSION: insert..returning on org still fails during bootstrap — the client must not use it", async () => {
    const newcomer = uuid();
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      newcomer,
      `${newcomer}@example.test`,
    ]);
    await expect(
      asUser(newcomer, () =>
        client.query("insert into org (name) values ('Returning Co') returning id"),
      ),
    ).rejects.toThrow(/row-level security/i);

    // ...and the same insert without RETURNING is accepted, which is what makes the
    // failure above about RETURNING and not about the insert.
    await expect(
      asUser(newcomer, () => client.query("insert into org (id, name) values ($1, 'Quiet Co')", [uuid()])),
    ).resolves.toBeDefined();
  });

  it("auth.org_id() resolves each user to their own org and nobody else's", async () => {
    const a = await asUser(carrierA.authUserId, () =>
      client.query<{ org: string }>("select auth.org_id()::text as org"),
    );
    const b = await asUser(carrierB.authUserId, () =>
      client.query<{ org: string }>("select auth.org_id()::text as org"),
    );
    expect(a.rows[0]!.org).toBe(carrierA.orgId);
    expect(b.rows[0]!.org).toBe(carrierB.orgId);
  });

  /**
   * O-13, the finding this whole policy exists for: 0001's `user_self_row` constrained
   * WHICH row you may write and said nothing about its org_id, so a first login — every
   * user has exactly one — could insert itself into somebody else's org and be legitimately
   * inside that tenant from then on.
   */
  it("O-13: a new identity CANNOT join an org that already has users", async () => {
    const intruder = uuid();
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      intruder,
      `${intruder}@example.test`,
    ]);

    await expect(
      asUser(intruder, () =>
        client.query("insert into \"user\" (id, org_id, role) values ($1, $2, 'owner')", [
          intruder,
          carrierA.orgId, // carrier A's org, which already has an owner
        ]),
      ),
    ).rejects.toThrow(/row-level security|violates row-level security policy/i);
  });

  it("O-13: and cannot smuggle itself in under somebody else's id either", async () => {
    const intruder = uuid();
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      intruder,
      `${intruder}@example.test`,
    ]);
    const emptyOrg = uuid();
    await asUserCommitted(intruder, () =>
      client.query("insert into org (id, name) values ($1, 'Empty Co')", [emptyOrg]),
    );

    // A THIRD identity, with no `user` row of its own. Using carrier B here would have
    // been the wrong test: carrier B already has a row, so the insert would fail on the
    // primary key and a duplicate-key error would have been mistaken for an RLS refusal.
    const victim = uuid();
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      victim,
      `${victim}@example.test`,
    ]);

    // The org is empty, so `org_has_no_users` is satisfied — the other half of the
    // policy, `id = auth.uid()`, is what has to refuse this.
    await expect(
      asUser(intruder, () =>
        client.query("insert into \"user\" (id, org_id, role) values ($1, $2, 'owner')", [
          victim, // not the caller
          emptyOrg,
        ]),
      ),
    ).rejects.toThrow(/row-level security|violates row-level security policy/i);
  });
});

// ---------------------------------------------------------------------------
// The boundary itself
// ---------------------------------------------------------------------------

describe("carrier A and carrier B cannot see each other", () => {
  let loadA: string;

  it("carrier A creates a load in its own org", async () => {
    // Here RETURNING is fine and it is worth seeing why: by now carrier A HAS a `user`
    // row, so `auth.org_id()` resolves, the row satisfies `load_org`'s using-expression,
    // and the SELECT policy lets its creator read it straight back. The bootstrap case is
    // the only one where the identity does not exist yet.
    loadA = await asUserCommitted(carrierA.authUserId, async () => {
      const row = await client.query<{ id: string }>(
        `insert into load (org_id, reference, state)
         values (auth.org_id(), 'A-0001', 'candidate_found') returning id`,
      );
      return row.rows[0]!.id;
    });
    expect(loadA).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("carrier A can read it back", async () => {
    const { rows } = await asUser(carrierA.authUserId, () =>
      client.query("select id from load where id = $1", [loadA]),
    );
    expect(rows).toHaveLength(1);
  });

  /** The line rule 12 is about. */
  it("carrier B reads ZERO rows of it — not an error, simply not there", async () => {
    const { rows } = await asUser(carrierB.authUserId, () =>
      client.query("select id from load where id = $1", [loadA]),
    );
    expect(rows).toHaveLength(0);
  });

  it("carrier B cannot see it in an unfiltered select either", async () => {
    // The previous case could pass against a policy that only filters by primary key.
    const { rows } = await asUser(carrierB.authUserId, () =>
      client.query<{ reference: string }>("select reference from load"),
    );
    expect(rows.map((r) => r.reference)).not.toContain("A-0001");
  });

  it("carrier B cannot UPDATE it", async () => {
    const { rowCount } = await asUser(carrierB.authUserId, () =>
      client.query("update load set reference = 'STOLEN' where id = $1", [loadA]),
    );
    expect(rowCount).toBe(0);
  });

  it("carrier B cannot DELETE it", async () => {
    const { rowCount } = await asUser(carrierB.authUserId, () =>
      client.query("delete from load where id = $1", [loadA]),
    );
    expect(rowCount).toBe(0);
  });

  it("carrier B cannot INSERT a row INTO carrier A's org", async () => {
    await expect(
      asUser(carrierB.authUserId, () =>
        client.query(
          `insert into load (org_id, reference, state)
           values ($1, 'B-FORGED', 'candidate_found')`,
          [carrierA.orgId],
        ),
      ),
    ).rejects.toThrow(/row-level security|violates row-level security policy/i);
  });

  it("and the row carrier A created is still exactly as carrier A left it", async () => {
    // Belt and braces: proves the four refusals above refused rather than silently
    // succeeding somewhere the reads could not see.
    const { rows } = await asUser(carrierA.authUserId, () =>
      client.query<{ reference: string }>("select reference from load where id = $1", [loadA]),
    );
    expect(rows[0]!.reference).toBe("A-0001");
  });
});

// ---------------------------------------------------------------------------
// The rail under the rails
// ---------------------------------------------------------------------------

describe("the boundary is structural, not incidental", () => {
  it("every public table has RLS both ENABLED and FORCED", async () => {
    // ENABLE alone leaves the table owner exempt, which is the half 0001 shipped.
    const { rows } = await client.query<{ relname: string }>(
      `select c.relname from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and (c.relrowsecurity = false or c.relforcerowsecurity = false)
        order by c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("every public table has at least one policy", async () => {
    // RLS with no policy denies everything — not a boundary, an outage waiting to be
    // "fixed" by turning RLS off.
    const { rows } = await client.query<{ relname: string }>(
      `select c.relname from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
        order by c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("is not vacuous — there really are tables and policies in here", async () => {
    const tables = await client.query<{ n: string }>(
      `select count(*)::text as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    const policies = await client.query<{ n: string }>(
      `select count(*)::text as n from pg_policy`,
    );
    expect(Number(tables.rows[0]!.n)).toBeGreaterThan(20);
    expect(Number(policies.rows[0]!.n)).toBeGreaterThan(20);
  });
});
