/**
 * EZ-BUILD-02 Slice 2 — the truck profile on real rows.
 *
 * Slice 2's done-when is "save -> reload -> values persist". That is a claim about a
 * database, so it is tested against one: the same embedded PostgreSQL, the same chain, the
 * same policies as `tenancy.test.ts`.
 *
 * The screen writes `truck` and `driver` through PostgREST as the `authenticated` role, so
 * that is how these cases write them. Every write goes through the policies — a test that
 * inserted as the owner role would prove the columns exist and nothing about whether a
 * driver can actually save their own profile.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const URL = process.env["TEST_DB_URL"] ?? process.env["DATABASE_URL"];

let client: pg.Client;
const uuid = () => crypto.randomUUID();

const carrier = { authUserId: uuid(), orgId: uuid(), orgName: "Freedom Trucking LLC" };
const other = { authUserId: uuid(), orgId: uuid(), orgName: "Rival Haulage Inc" };

async function asUser<T>(authUserId: string, fn: () => Promise<T>, commit = false): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: authUserId, role: "authenticated" }),
    ]);
    const result = await fn();
    await client.query(commit ? "commit" : "rollback");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

beforeAll(async () => {
  if (!URL) throw new Error("no TEST_DB_URL — these run through `bun run test:db`");
  client = new pg.Client({ connectionString: URL });
  await client.connect();

  for (const c of [carrier, other]) {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      c.authUserId,
      `${c.authUserId}@example.test`,
    ]);
    // The bootstrap, exactly as src/lib/session.ts does it: caller-chosen org id, no
    // RETURNING. (See tenancy.test.ts for why RETURNING is fatal here.)
    await asUser(
      c.authUserId,
      async () => {
        await client.query("insert into org (id, name) values ($1, $2)", [c.orgId, c.orgName]);
        await client.query('insert into "user" (id, org_id, role) values ($1, $2, \'owner\')', [
          c.authUserId,
          c.orgId,
        ]);
      },
      true,
    );
  }
});

afterAll(async () => {
  await client?.end();
});

describe("save -> reload -> the values are still there", () => {
  /** What the screen sends: every figure the estimate needs, typed by the driver. */
  const profile = {
    unit_number: "TRK-217",
    equipment: "reefer",
    mpg_loaded: 6.1,
    mpg_empty: 7.2,
    fuel_discount_per_gal: 0, // a real answer from a driver with no fuel card
    maintenance_reserve_per_mile: 0.14,
    tire_reserve_per_mile: 0.05,
    overhead_per_day: 185,
    driver_pay_type: "per_mile",
    driver_pay_value: 0.62,
    cpm_target: 1.71,
    max_deadhead_miles: 120,
    height_ft: 13.6,
    length_ft: 53,
    weight_lb: 34000,
    hazmat: false,
    home_base_lat: 35.1495,
    home_base_lng: -90.049,
    banned_states: ["NY", "CA"],
  };

  let truckId: string;

  it("the driver can insert their own truck", async () => {
    truckId = await asUser(
      carrier.authUserId,
      async () => {
        const columns = ["org_id", ...Object.keys(profile)];
        const values = [carrier.orgId, ...Object.values(profile)];
        const params = values.map((_, i) => `$${i + 1}`).join(", ");
        const id = uuid();
        await client.query(
          `insert into truck (id, ${columns.join(", ")}) values ('${id}', ${params})`,
          values,
        );
        return id;
      },
      true,
    );
    expect(truckId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("every figure comes back exactly as it was typed", async () => {
    // Field by field rather than a shape match: a truncated numeric or a silently
    // defaulted column is the failure this case exists to catch, and `toMatchObject` on
    // the whole row would let a wrong-but-present value through.
    const { rows } = await asUser(carrier.authUserId, () =>
      client.query<Record<string, unknown>>("select * from truck where id = $1", [truckId]),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row["unit_number"]).toBe(profile.unit_number);
    expect(row["equipment"]).toBe(profile.equipment);
    expect(row["hazmat"]).toBe(false);
    expect(row["banned_states"]).toEqual(profile.banned_states);
    expect(row["max_deadhead_miles"]).toBe(profile.max_deadhead_miles);
    expect(row["weight_lb"]).toBe(profile.weight_lb);

    // numerics come back as strings from pg; compare as numbers, which is also what the
    // screen does when it re-fills the form.
    for (const key of [
      "mpg_loaded",
      "mpg_empty",
      "fuel_discount_per_gal",
      "maintenance_reserve_per_mile",
      "tire_reserve_per_mile",
      "overhead_per_day",
      "driver_pay_value",
      "cpm_target",
      "height_ft",
      "length_ft",
    ] as const) {
      expect(Number(row[key]), key).toBeCloseTo(profile[key], 6);
    }
    expect(Number(row["home_base_lat"])).toBeCloseTo(profile.home_base_lat, 6);
    expect(Number(row["home_base_lng"])).toBeCloseTo(profile.home_base_lng, 6);
  });

  it("a zero the driver typed stays a zero, and does not become the column default", async () => {
    // `fuel_discount_per_gal` defaults to 0 and `maintenance_reserve_per_mile` to 0.12.
    // A save that dropped the field would look identical for the first and wrong for the
    // second, so this asserts the one that can actually tell them apart.
    const { rows } = await asUser(carrier.authUserId, () =>
      client.query<{ fuel: string; maint: string }>(
        "select fuel_discount_per_gal as fuel, maintenance_reserve_per_mile as maint from truck where id = $1",
        [truckId],
      ),
    );
    expect(Number(rows[0]!.fuel)).toBe(0);
    expect(Number(rows[0]!.maint)).toBe(0.14); // NOT the 0.12 default
  });

  it("editing persists the edit, and only the edit", async () => {
    await asUser(
      carrier.authUserId,
      () => client.query("update truck set overhead_per_day = 205 where id = $1", [truckId]),
      true,
    );
    const { rows } = await asUser(carrier.authUserId, () =>
      client.query<{ overhead: string; unit: string }>(
        "select overhead_per_day as overhead, unit_number as unit from truck where id = $1",
        [truckId],
      ),
    );
    expect(Number(rows[0]!.overhead)).toBe(205);
    expect(rows[0]!.unit).toBe("TRK-217");
  });
});

describe("the HOS figure is the driver's own number", () => {
  it("saves and reloads on the driver row", async () => {
    const driverId = await asUser(
      carrier.authUserId,
      async () => {
        const id = uuid();
        await client.query(
          "insert into driver (id, org_id, name, hos_hours_left) values ($1, $2, $3, $4)",
          [id, carrier.orgId, "Andrew", 8.5],
        );
        return id;
      },
      true,
    );
    const { rows } = await asUser(carrier.authUserId, () =>
      client.query<{ hours: string }>("select hos_hours_left as hours from driver where id = $1", [
        driverId,
      ]),
    );
    expect(Number(rows[0]!.hours)).toBe(8.5);
  });

  it("is ONE hand-typed number, because the frozen schema holds one", async () => {
    // The ticket asks for three HOS fields. `driver` has exactly one HOS column,
    // `hos_hours_left`, and BUILD_DEFAULTS §2 is explicit that when a screen wants a column
    // the schema does not have, the SCREEN adapts. This pins that reading so the next
    // person does not "fix" it by adding columns to a frozen schema — the other two are
    // recorded in NOT_BUILT_YET.md.
    const { rows } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'driver' and column_name like '%hos%'
        order by column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["hos_hours_left"]);
  });
});

describe("a truck belongs to one carrier", () => {
  it("the other carrier cannot see it", async () => {
    const { rows } = await asUser(other.authUserId, () =>
      client.query("select id from truck where org_id = $1", [carrier.orgId]),
    );
    expect(rows).toHaveLength(0);
  });

  it("the other carrier cannot create a truck inside it", async () => {
    await expect(
      asUser(other.authUserId, () =>
        client.query("insert into truck (org_id, unit_number) values ($1, 'FORGED')", [
          carrier.orgId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("the other carrier cannot edit it", async () => {
    const { rowCount } = await asUser(other.authUserId, () =>
      client.query("update truck set overhead_per_day = 1 where org_id = $1", [carrier.orgId]),
    );
    expect(rowCount).toBe(0);
  });
});
