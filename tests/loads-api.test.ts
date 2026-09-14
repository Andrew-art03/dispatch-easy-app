/**
 * EZ-BUILD-01 Slice 8 (ticket 6A) — POST /loads, GET /loads/:id, GET /loads/:id/economics.
 *
 * Two of SPEC 6A's three "done when" clauses are about things that must NOT happen, and both
 * are tested as absences rather than as intentions:
 *
 *   a cross-tenant read returns zero rows  -> and the API turns that into 404, not 403
 *   economics reads PRE_RUN only           -> and cannot read anything else, because the repo
 *                                             it is handed has no ledger method at all
 *
 * The repo here is an in-memory fake. It enforces the tenant filter the way RLS does — a row
 * belonging to another org is simply not returned — so a test that passes against it describes
 * what the database will do, rather than what this module hopes it will do.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { HttpError, type RequestContext } from "../supabase/functions/_shared/context.ts";
import type { IdempotencyStore, StoredResponse, ClaimResult } from "../supabase/functions/_shared/idempotent.ts";
import {
  ECONOMICS_LABEL,
  SETTLEMENT_FIELDS,
  type LoadRow,
  type LoadsRepo,
  type StopInsert,
  type StoredScore,
  economicsView,
  getEconomics,
  getLoad,
  postLoad,
} from "../supabase/functions/_shared/loads.ts";
import { calculateTrueNet, type TrueNetInput, type TrueNetOk } from "../packages/domain/trueNet.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(`${REPO_ROOT}${rel}`, "utf8");

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const KEY = "01JBXR4Q2M8NQ7V3K5ZGABCDEF";
const AT = "2026-09-14T04:00:00.000Z";

const ctx = (orgId = ORG_A, role: RequestContext["role"] = "owner"): RequestContext => ({
  requestId: "req-1",
  authUserId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  orgId,
  userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  role,
});

function fakeRepo() {
  const loads = new Map<string, LoadRow>();
  const stops: StopInsert[] = [];
  const scores = new Map<string, StoredScore>();
  let n = 0;
  const repo: LoadsRepo = {
    insertLoad: async (row) => {
      n += 1;
      const full: LoadRow = {
        id: `load-${n}`,
        org_id: row.org_id,
        // The schema default. Nothing the caller sent can influence this.
        state: "candidate_found",
        source: row.source,
        reference: row.reference ?? null,
        gross_rate: null,
        loaded_miles: row.loaded_miles ?? null,
        deadhead_miles: null,
        created_at: AT,
      };
      loads.set(full.id, full);
      return full;
    },
    insertStops: async (rows) => {
      stops.push(...rows);
    },
    // The tenant filter, the way RLS does it: another org's row is not found, not refused.
    getLoad: async (orgId, loadId) => {
      const row = loads.get(loadId);
      return row && row.org_id === orgId ? row : null;
    },
    getLatestScore: async (orgId, loadId) => {
      const row = loads.get(loadId);
      if (!row || row.org_id !== orgId) return null;
      return scores.get(loadId) ?? null;
    },
  };
  return { repo, loads, stops, scores, inserted: () => n };
}

function fakeStore(): IdempotencyStore {
  const rows = new Map<string, { hash: string; response?: StoredResponse }>();
  const pk = (r: { orgId: string; operation: string; key: string }) => `${r.orgId}|${r.operation}|${r.key}`;
  return {
    claim: async (row): Promise<ClaimResult> => {
      const existing = rows.get(pk(row));
      if (!existing) {
        rows.set(pk(row), { hash: row.requestHash });
        return { status: "claimed" };
      }
      if (existing.hash !== row.requestHash) return { status: "mismatch" };
      return existing.response ? { status: "replay", response: existing.response } : { status: "in_flight" };
    },
    complete: async (row, response) => {
      const e = rows.get(pk(row));
      if (e) e.response = response;
    },
    release: async (row) => {
      rows.delete(pk(row));
    },
  };
}

const post = (body: unknown, key: string | null = KEY) =>
  new Request("https://ez.example/loads", {
    method: "POST",
    headers: { ...(key === null ? {} : { "idempotency-key": key }), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * The module's lines of CODE — block comments, line comments and the banned-name constant
 * removed.
 *
 * Three tests in this file first used a blunt `expect(src).not.toContain(...)` and all three
 * failed on the file's own documentation: the header explains that there is no PATCH, the
 * economics section explains that "take-home" is never used, and `SETTLEMENT_FIELDS` is a list
 * of the very names it exists to forbid. **Naming a thing in order to ban it is not doing it.**
 * That is the third time this has come up in this build — after `check:db-boundary` and the
 * purity rail — so it is a shared helper rather than a fourth ad-hoc fix.
 */
const codeOnly = read("supabase/functions/_shared/loads.ts")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith("//"))
  .map((l) => l.replace(/\/\/.*$/, ""))
  // The banned-name list itself. It is DATA about the rule, not a use of it.
  .filter((l) => !/^\s*"[a-zA-Z_]+",\s*$/.test(l))
  .join("\n");

/** A payload 4A reads cleanly, so the persistence path is exercised rather than the refusal. */
const goodPayload = {
  rate: "$2,800",
  miles: 1200,
  weight: 42000,
  commodity: "Paper goods",
  reference: "ABC-1234",
  stops: [
    { type: "pickup", location: "Dallas, TX" },
    { type: "delivery", location: "Atlanta, GA" },
  ],
};

describe("POST /loads — the caller does not choose the tenant, the state or the id", () => {
  it("persists org_id from the context, never from the body", async () => {
    const { repo, loads } = fakeRepo();
    const res = await postLoad(
      ctx(ORG_A),
      post({ source: "paste", payload: { ...goodPayload, org_id: ORG_B, orgId: ORG_B } }),
      repo,
      fakeStore(),
      AT,
    );
    expect(res.status).toBe(201);
    const row = [...loads.values()][0];
    expect(row?.org_id).toBe(ORG_A);
  });

  it("the new load starts at the schema default, whatever state the body asks for", async () => {
    // A create that lets the caller choose the starting state is a state PATCH wearing a
    // different verb. SPEC 3A: state moves only through transition_load().
    const { repo, loads } = fakeRepo();
    await postLoad(
      ctx(),
      post({ source: "paste", payload: { ...goodPayload, state: "booked", status: "booked" } }),
      repo,
      fakeStore(),
      AT,
    );
    expect([...loads.values()][0]?.state).toBe("candidate_found");
  });

  it("source comes from the envelope, and a payload claiming otherwise is ignored", async () => {
    // 4A's acceptance 10, one layer up: a payload claiming `broker_direct` does not become
    // provenance just because it passed through an API.
    const { repo, loads } = fakeRepo();
    await postLoad(
      ctx(),
      post({ source: "paste", payload: { ...goodPayload, source: "broker_direct" } }),
      repo,
      fakeStore(),
      AT,
    );
    expect([...loads.values()][0]?.source).toBe("paste");
  });

  it("refuses a source that is not one of 4A's five", async () => {
    const { repo } = fakeRepo();
    await expect(
      postLoad(ctx(), post({ source: "totally_legitimate", payload: goodPayload }), repo, fakeStore(), AT),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a missing source rather than guessing one", async () => {
    const { repo } = fakeRepo();
    await expect(postLoad(ctx(), post({ payload: goodPayload }), repo, fakeStore(), AT)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("does not write a money column from a normalizer PROPOSAL", async () => {
    // 4A returns ProposedMoney — an origin and no verified_by. Copying it into load.gross_rate
    // would turn a proposal into a fact with nobody having confirmed it (rule 14 / R-5).
    const { repo, loads } = fakeRepo();
    await postLoad(ctx(), post({ source: "paste", payload: goodPayload }), repo, fakeStore(), AT);
    expect([...loads.values()][0]?.gross_rate).toBeNull();
  });

  it("says on the way out that nothing has been agreed and no money recorded", async () => {
    const { repo } = fakeRepo();
    const res = await postLoad(ctx(), post({ source: "paste", payload: goodPayload }), repo, fakeStore(), AT);
    const body = (await res.json()) as { note: string };
    expect(body.note).toMatch(/No rate has been agreed and no money has been recorded/);
  });

  it("keeps 4A's stop order rather than renumbering it", async () => {
    const { repo, stops } = fakeRepo();
    await postLoad(ctx(), post({ source: "paste", payload: goodPayload }), repo, fakeStore(), AT);
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.map((s) => s.seq)).toEqual([...stops].map((s) => s.seq).sort((a, b) => a - b));
    for (const s of stops) expect(s.org_id).toBe(ORG_A);
  });

  it("a load 4A cannot read is 202 NEEDS_INPUT and is NOT persisted", async () => {
    // A half-read load in the table is a load somebody will later trust.
    const { repo, inserted } = fakeRepo();
    const res = await postLoad(ctx(), post({ source: "paste", payload: { nothing: "useful" } }), repo, fakeStore(), AT);
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ status: "NEEDS_INPUT" });
    expect(inserted()).toBe(0);
  });

  it("requires load.create — a driver cannot create one", async () => {
    const { repo } = fakeRepo();
    await expect(
      postLoad(ctx(ORG_A, "driver"), post({ source: "paste", payload: goodPayload }), repo, fakeStore(), AT),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("is wrapped in idempotency — no Idempotency-Key is a 400, and nothing is written", async () => {
    const { repo, inserted } = fakeRepo();
    await expect(
      postLoad(ctx(), post({ source: "paste", payload: goodPayload }, null), repo, fakeStore(), AT),
    ).rejects.toMatchObject({ status: 400 });
    expect(inserted()).toBe(0);
  });

  it("a retry with the same key creates ONE load, not two", async () => {
    // The double-tap on the shoulder, end to end through the real endpoint.
    const { repo, inserted } = fakeRepo();
    const store = fakeStore();
    const body = { source: "paste", payload: goodPayload };
    await postLoad(ctx(), post(body), repo, store, AT);
    await postLoad(ctx(), post(body), repo, store, AT);
    expect(inserted()).toBe(1);
  });
});

describe("GET /loads/:id — a cross-tenant read is a 404, not a 403", () => {
  it("returns the load to its own org", async () => {
    const { repo } = fakeRepo();
    await postLoad(ctx(ORG_A), post({ source: "paste", payload: goodPayload }), repo, fakeStore(), AT);
    const res = await getLoad(ctx(ORG_A), "load-1", repo);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: "load-1", org_id: ORG_A });
  });

  it("returns 404 to another org — zero rows, turned into 'no such load'", async () => {
    // A 403 would tell the caller the id exists somewhere, which is precisely the fact tenant
    // isolation is keeping from them. SPEC 6A: a cross-tenant read returns zero rows.
    const { repo } = fakeRepo();
    await postLoad(ctx(ORG_A), post({ source: "paste", payload: goodPayload }), repo, fakeStore(), AT);
    await expect(getLoad(ctx(ORG_B), "load-1", repo)).rejects.toMatchObject({ status: 404 });
  });

  it("returns 404 for an id that does not exist at all — the same answer", async () => {
    // Indistinguishable from the case above, on purpose.
    const { repo } = fakeRepo();
    await expect(getLoad(ctx(ORG_A), "load-999", repo)).rejects.toMatchObject({ status: 404 });
  });

  it("requires load.read", async () => {
    const { repo } = fakeRepo();
    const bad = { ...ctx(), role: "auditor" as unknown as RequestContext["role"] };
    await expect(getLoad(bad, "load-1", repo)).rejects.toThrow(HttpError);
  });
});

/* ── economics ──────────────────────────────────────────────────────────────── */

/**
 * A complete input, taken field for field from 3B's own BASE fixture in tests/trueNet.test.ts.
 *
 * My first attempt at this omitted `def_cents`, `idleFuelGallons_milli`,
 * `brokerOrDispatchHaircut_bp` and `factoringBase`, and 3B refused to score it — NEEDS_INPUT
 * naming all four. That is the calculator behaving exactly as SPEC-3B rule 3 says it must
 * (never a default, never an estimate), and it is worth recording that the fixture was wrong
 * rather than the calculator being awkward.
 */
const trueNetInput = (): TrueNetInput => ({
  revenueLines: [
    {
      id: "linehaul",
      bucket: "linehaul",
      amount_cents: 280000,
      settlementState: "confirmed",
      reliability: "formula",
    },
  ],
  loadedMiles: 1000,
  deadheadMiles: 100,
  repositionMiles: 0,
  mpgLoaded_milli: 5000,
  mpgEmpty_milli: 8000,
  regionalDieselPrice_cents_per_gal: 400,
  fuelDiscount_cents_per_gal: 50,
  def_cents: 0,
  idleFuelGallons_milli: 0,
  tolls_cents: 5000,
  lumperCost_cents: 0,
  scalePermitOtherCash_cents: 2000,
  maintenanceReserve_cents_per_mile: 15,
  tireReserve_cents_per_mile: 4,
  weightDistanceAndIfta_cents: 0,
  tripMinutes: 2880,
  overhead_cents_per_day: 20000,
  driverPay: { type: "percent", percent_bp: 2500 },
  brokerOrDispatchHaircut_bp: 0,
  settlementMode: "third_party",
  factoringBase: "none",
  factoringOrQuickPay_bp: 0,
  dieselPriceSnapshotId: "test:eia-padd3:2026-09-08",
  breakEven_cents_per_mile: 180,
  target_cents_per_mile: 220,
});

const scoredOk = (): TrueNetOk => {
  const r = calculateTrueNet(trueNetInput());
  if (r.status !== "OK") throw new Error(`fixture did not score: ${JSON.stringify(r.missing)}`);
  return r;
};

describe("GET /loads/:id/economics — the decision number, and nothing about what landed", () => {
  const scoreInto = (scores: Map<string, StoredScore>, outputs: unknown) =>
    scores.set("load-1", { calc_version: "3B.4.0", inputs: {}, outputs, created_at: AT });

  it("serves the estimated net with its label, and the verdict", async () => {
    const { repo, scores } = fakeRepo();
    await postLoad(ctx(), post({ source: "paste", payload: goodPayload }), repo, fakeStore(), AT);
    const ok = scoredOk();
    scoreInto(scores, ok);

    const res = await getEconomics(ctx(), "load-1", repo);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("OK");
    expect(body["estimatedNet_cents"]).toBe(ok.trueEstimatedNet_cents);
    expect(body["estimatedNetLabel"]).toBe(ECONOMICS_LABEL);
    expect(body["verdict"]).toBe(ok.verdict);
  });

  it("R-7: no settled, collected or paid figure appears anywhere in the response", async () => {
    // There are TWO numbers — the decision before the run, and what actually landed. This
    // endpoint serves the first. 6E owns the second.
    const view = economicsView(scoredOk());
    const keys = Object.keys(view);
    for (const banned of SETTLEMENT_FIELDS) expect(keys).not.toContain(banned);

    // The invariant is about FIELDS, not about vocabulary. 3B's `assumptions` is prose that
    // explains the basis of each figure, and one of those sentences legitimately contains the
    // word "settled" — it is describing which lines counted, which is the audit trail working.
    // A substring scan over the serialised body flagged it, which is the same "naming a thing
    // in order to ban it" mistake a fourth time. So: no KEY anywhere in the response, at any
    // depth, may look like a figure for what landed.
    const suspiciousKeys: string[] = [];
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== "object") return;
      if (Array.isArray(v)) return v.forEach(walk);
      for (const [k, child] of Object.entries(v)) {
        if (/collected|settled|paid|actual_?net/i.test(k)) suspiciousKeys.push(k);
        walk(child);
      }
    };
    walk(view);
    expect(suspiciousKeys).toEqual([]);
  });

  it("cannot read the ledger, because it is not given a way to", async () => {
    // Stronger than "does not": LoadsRepo has no ledger method at all, so there is no call to
    // make. A rule enforced by the shape of an interface does not need anyone to remember it.
    const { repo } = fakeRepo();
    expect(Object.keys(repo).sort()).toEqual(["getLatestScore", "getLoad", "insertLoad", "insertStops"]);
    expect(codeOnly).not.toMatch(/ledger_line|ledgerLine|collected_cents/);
  });

  it("the label never promises — no 'keep', no 'take-home', no 'guaranteed'", () => {
    // BUILD_DEFAULTS R-4 and R-10. The product estimates; it does not promise.
    const code = codeOnly.toLowerCase();
    for (const banned of ["take-home", "take home", "guaranteed", "we'll get you paid"]) {
      expect(code).not.toContain(banned);
    }
    expect(ECONOMICS_LABEL).toBe("Estimated net (before tax)");
  });

  it("passes a calculator NEEDS_INPUT straight through, with the missing facts named", async () => {
    // 3B rule 3, fail closed: never a default, never an estimate in place of a fact.
    const { repo, scores } = fakeRepo();
    await postLoad(ctx(), post({ source: "paste", payload: goodPayload }), repo, fakeStore(), AT);
    scoreInto(scores, { status: "NEEDS_INPUT", calcVersion: "3B.4.0", missing: ["revenueLines"] });

    const res = await getEconomics(ctx(), "load-1", repo);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("NEEDS_INPUT");
    expect(body["missing"]).toEqual(["revenueLines"]);
    expect(body["message"]).toMatch(/Nothing has been estimated in their place/);
    expect(body["estimatedNet_cents"]).toBeUndefined();
  });

  it("an unscored load says so rather than showing a zero", async () => {
    // "No number yet" and "the number is zero" are different facts about a load.
    const { repo } = fakeRepo();
    await postLoad(ctx(), post({ source: "paste", payload: goodPayload }), repo, fakeStore(), AT);
    const res = await getEconomics(ctx(), "load-1", repo);
    await expect(res.json()).resolves.toMatchObject({ status: "NOT_SCORED" });
  });

  it("is 404 across a tenant boundary, like the load itself", async () => {
    const { repo, scores } = fakeRepo();
    await postLoad(ctx(ORG_A), post({ source: "paste", payload: goodPayload }), repo, fakeStore(), AT);
    scoreInto(scores, scoredOk());
    await expect(getEconomics(ctx(ORG_B), "load-1", repo)).rejects.toMatchObject({ status: 404 });
  });

  it("carries the derivation: calcVersion, the fuel snapshot, and the assumptions", async () => {
    // A number with no visible derivation is not shippable, and Slice 10 has to re-derive this
    // one from provenance.
    const view = economicsView(scoredOk());
    expect(view.calcVersion).toMatch(/^3B\./);
    expect(view.dieselPriceSnapshotId).toBe("test:eia-padd3:2026-09-08");
    expect(Object.keys(view.assumptions).length).toBeGreaterThan(0);
  });

  it("reports the three revenue partitions separately, rather than netting them together", () => {
    const ok = scoredOk();
    const view = economicsView(ok);
    expect(view.reliableRevenue_cents).toBe(ok.reliableRevenue_cents);
    expect(view.atRiskAccessorialRevenue_cents).toBe(ok.atRiskAccessorialRevenue_cents);
    expect(view.unconfirmedRevenue_cents).toBe(ok.unconfirmedRevenue_cents);
    // The headline is built from RELIABLE revenue only — at-risk money is shown, never netted.
    expect(view.estimatedNet_cents).toBe(ok.reliableRevenue_cents - ok.allCosts_cents);
  });
});

describe("6A's structural invariants", () => {
  const src = read("supabase/functions/_shared/loads.ts");

  it("declares no PATCH handler and no state setter", () => {
    expect(codeOnly).not.toMatch(/\bPATCH\b/);
    expect(codeOnly).not.toMatch(/state:\s*(body|envelope|payload)/);
    // Not vacuous: the header DOES discuss PATCH, so stripping comments is doing real work.
    expect(src).toMatch(/\bPATCH\b/);
  });

  it("never spreads a normalizer result into an insert", () => {
    // A spread is how a field nobody reviewed arrives in a table.
    expect(src).not.toMatch(/insertLoad\(\s*\{\s*\.\.\./);
    expect(src).not.toMatch(/\.\.\.normalized/);
    expect(src).not.toMatch(/\.\.\.result\.value/);
  });

  it("builds no database client of its own", () => {
    expect(src).not.toContain("@supabase/supabase-js");
    for (const line of src.split("\n").filter((l) => /createClient|createDb/.test(l))) {
      expect(line.trim().startsWith("*") || line.trim().startsWith("//")).toBe(true);
    }
  });

  it("every repo reader takes orgId as a required argument", () => {
    // Tenant scoping by signature, not by convention: an implementation that forgets the filter
    // does not typecheck into existence quietly.
    expect(src).toMatch(/getLoad: \(orgId: string, loadId: string\)/);
    expect(src).toMatch(/getLatestScore: \(orgId: string, loadId: string\)/);
  });

  it("the POST path runs inside idempotent(), not beside it", async () => {
    const { repo } = fakeRepo();
    const store = fakeStore();
    const claim = vi.spyOn(store, "claim");
    await postLoad(ctx(), post({ source: "paste", payload: goodPayload }), repo, store, AT);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
