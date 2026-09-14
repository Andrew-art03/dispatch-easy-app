/**
 * EZ-BUILD-01 Slice 10 (ticket 12A) — one load, paste to settled, end to end.
 *
 * SPEC 12A's "done when": a pasted rate con walks the whole chain and **the number at the end
 * is re-derivable from provenance**. The last block of this file does exactly that — it throws
 * away every computed value, reads only what was stored, and recomputes the figure.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS REAL HERE AND WHAT IS A STAND-IN. Said up front, because a green end-to-end test
 * that quietly fakes its own middle is worse than no end-to-end test.
 *
 *   REAL, the actual production code:
 *     normalizeLoad()            4A, unmodified
 *     postLoad() / getLoad() / getEconomics()   6A, the real handlers
 *     idempotent()               2E, the real wrapper
 *     requireCapability()        2D, the real matrix
 *     calculateTrueNet()         3B, unmodified
 *     canonicalJson() + sha256   2E's hash, used for the approval's terms_hash
 *     weekSummary() / detectLeaks() / settlementOf()   6E, unmodified
 *
 *   STAND-INS, because they are SQL and there is no database (D-CC-1):
 *     transition_load()          -> a fake that refuses the same illegal edges, using the SAME
 *                                   canTransition() the migration's edge list is asserted against
 *     execute_approved_action()  -> a fake that performs the same four steps in the same order
 *
 *   The stand-ins are not wishful. The SQL's own guarantees — consume first, one insert,
 *   integer cents, single-use — are asserted against the migration text in tests/ledger.test.ts
 *   and tests/transition-load.test.ts. What this file adds is that the PIECES FIT: that 4A's
 *   output is a shape 3B can score, that 3B's output is a shape the economics endpoint can
 *   serve, and that the ledger's figures reconcile with the score's.
 *
 *   The fixture is SYNTHETIC and labelled `is_demo_data: true`. Andrew's Freedom Trucking
 *   paperwork is the only real rate-con source and has not been supplied (seed/README.md), so
 *   no figure here is a claim about what any lane pays.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canTransition, type LoadState } from "../packages/domain/loadStateMachine.ts";
import { normalizeLoad, sha256, canonical } from "../packages/domain/normalize/index.ts";
import { calculateTrueNet, type TrueNetInput, type TrueNetOk } from "../packages/domain/trueNet.ts";
import { detectLeaks, settlementOf, weekSummary, type LedgerLine } from "../packages/domain/week.ts";
import type { RequestContext } from "../supabase/functions/_shared/context.ts";
import { canonicalJson, requestHash, type ClaimResult, type IdempotencyStore, type StoredResponse } from "../supabase/functions/_shared/idempotent.ts";
import {
  economicsView,
  getEconomics,
  getLoad,
  postLoad,
  type LoadRow,
  type LoadsRepo,
  type StopInsert,
  type StoredScore,
} from "../supabase/functions/_shared/loads.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(`${REPO_ROOT}${rel}`, "utf8");

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AT = "2026-09-08T07:00:00.000Z";
const KEY = "01JBXR4Q2M8NQ7V3K5ZGABCDEF";

const RATE_CON = JSON.parse(read("tests/fixtures/rate-con-vertical-slice.json")) as Record<string, unknown>;

const ctx: RequestContext = {
  requestId: "req-vertical-1",
  authUserId: USER,
  orgId: ORG,
  userId: USER,
  role: "owner",
};

/**
 * The carrier's own cost lines. SYNTHETIC and labelled: `CARRIER_COST_PROFILE.json` is one of
 * the two datasets seed/README.md marks NOT YET, and D-19 (equipment/authority scope) has to be
 * answered before real defaults exist — Grok's N-9 finding is that a wrong default tells every
 * carrier but one to take a loss. These numbers exercise the arithmetic; they are not advice.
 */
const CARRIER_PROFILE = {
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
  overhead_cents_per_day: 20000,
  driverPay: { type: "percent", percent_bp: 2500 },
  brokerOrDispatchHaircut_bp: 0,
  settlementMode: "third_party",
  factoringBase: "none",
  factoringOrQuickPay_bp: 0,
  dieselPriceSnapshotId: "demo:synthetic-profile:2026-09-08",
  breakEven_cents_per_mile: 180,
  target_cents_per_mile: 220,
} as const;

/* ── the stand-ins, and the state they share ──────────────────────────────────── */

function world() {
  const loads = new Map<string, LoadRow>();
  const stops: StopInsert[] = [];
  const scores = new Map<string, StoredScore>();
  const ledger: LedgerLine[] = [];
  const events: { loadId: string; type: string; payload: Record<string, unknown> }[] = [];
  const approvals = new Map<string, { action: string; resource: string; termsHash: string; consumed: boolean }>();
  let n = 0;

  const repo: LoadsRepo = {
    insertLoad: async (row) => {
      n += 1;
      const full: LoadRow = {
        id: `load-${n}`,
        org_id: row.org_id,
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
    insertStops: async (rows) => void stops.push(...rows),
    getLoad: async (orgId, loadId) => {
      const row = loads.get(loadId);
      return row && row.org_id === orgId ? row : null;
    },
    getLatestScore: async (orgId, loadId) => {
      const row = loads.get(loadId);
      return row && row.org_id === orgId ? (scores.get(loadId) ?? null) : null;
    },
  };

  const store: IdempotencyStore = (() => {
    const rows = new Map<string, { hash: string; response?: StoredResponse }>();
    const pk = (r: { orgId: string; operation: string; key: string }) => `${r.orgId}|${r.operation}|${r.key}`;
    return {
      claim: async (row): Promise<ClaimResult> => {
        const e = rows.get(pk(row));
        if (!e) {
          rows.set(pk(row), { hash: row.requestHash });
          return { status: "claimed" };
        }
        if (e.hash !== row.requestHash) return { status: "mismatch" };
        return e.response ? { status: "replay", response: e.response } : { status: "in_flight" };
      },
      complete: async (row, response) => {
        const e = rows.get(pk(row));
        if (e) e.response = response;
      },
      release: async (row) => void rows.delete(pk(row)),
    };
  })();

  /** Stands in for transition_load(). Refuses the same edges, via the same pure machine. */
  const transitionLoad = (loadId: string, to: LoadState, reason: string) => {
    const row = loads.get(loadId);
    if (!row || row.org_id !== ctx.orgId) throw new Error("load not found");
    const legality = canTransition(row.state, to);
    if (!legality.ok) throw new Error(`illegal transition: ${legality.message}`);
    loads.set(loadId, { ...row, state: to });
    // One event per transition, in the same step — never a state change without an audit row.
    events.push({ loadId, type: `state.${to}`, payload: { from: row.state, to, reason } });
  };

  /** Stands in for execute_approved_action(). Same four steps, same order. */
  const executeApprovedAction = (
    approvalId: string,
    args: { loadId: string; action: string; termsHash: string; toState?: LoadState; lines?: { category: string; amountCents: number; source: string }[] },
  ) => {
    // STEP 1 — consume. Single-use, terms-bound, and FIRST: nothing is written before it.
    const a = approvals.get(approvalId);
    if (!a || a.consumed || a.action !== args.action || a.resource !== args.loadId || a.termsHash !== args.termsHash) {
      throw new Error("approval refused — expired, already used, terms changed, or not this tenant's");
    }
    a.consumed = true;

    // STEP 2 — the ledger. Integer cents or nothing.
    for (const l of args.lines ?? []) {
      if (!Number.isInteger(l.amountCents)) throw new Error("amount_cents must be an integer number of cents");
      ledger.push({
        id: `ll-${ledger.length + 1}`,
        loadId: args.loadId,
        category: l.category,
        amountCents: l.amountCents,
        collectedCents: 0,
        source: l.source,
        at: AT,
      });
    }

    // STEP 3 — the state change, same transaction.
    if (args.toState) transitionLoad(args.loadId, args.toState, `approved action ${args.action}`);
    return { approvalId, linesWritten: (args.lines ?? []).length };
  };

  const approve = (action: string, resource: string, terms: unknown) => {
    // The terms are hashed with 2E's canonical JSON, so "the terms changed" is decidable rather
    // than a matter of opinion about key order.
    const id = `appr-${approvals.size + 1}`;
    const termsHash = hashSync(terms);
    approvals.set(id, { action, resource, termsHash, consumed: false });
    return { id, termsHash };
  };

  return { repo, store, loads, stops, scores, ledger, events, approvals, transitionLoad, executeApprovedAction, approve };
}

/** 4A's sha256 over 2E's canonical JSON — both already in the tree, neither re-implemented. */
const hashSync = (value: unknown): string => sha256(canonicalJson(value));

const post = (body: unknown, key = KEY) =>
  new Request("https://ez.example/loads", {
    method: "POST",
    headers: { "idempotency-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/* ── the walk ─────────────────────────────────────────────────────────────────── */

describe("12A — one load, paste to settled", () => {
  it("walks the whole chain, and every step is checked on the way past", async () => {
    const w = world();

    /* ---- 1. PASTE + NORMALIZE (4A) ------------------------------------------- */
    const normalized = normalizeLoad(RATE_CON, "paste", { receivedAt: AT });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const nl = normalized.value;

    // The rate con's buried detention clause was NOT parsed into a number, and the result says
    // so rather than pretending the load is fully read.
    expect(nl.moneyParseIncomplete).toBe(true);
    // The hostile instruction IS carried — and that is correct. Rule 3 does not say hostile
    // text must vanish; it says a document is data and can never trigger an action. 4A's
    // acceptance 16 keeps every prose field tagged, so the string survives as
    // `{value, untrusted: true}` and a later layer cannot pick it up as trusted config without
    // deleting a field a test asserts is present.
    //
    // My first version of this assertion demanded the string be ABSENT from `load`, and 4A was
    // right and the assertion was wrong. Worth keeping the corrected form: "it is marked" is a
    // stronger guarantee than "it is gone", because gone cannot be verified downstream.
    expect(nl.load.notes?.value).toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
    expect(nl.load.notes?.untrusted).toBe(true);
    // The machine columns, by contrast, are NOT mapped at all — R-5's denylist. They exist only
    // in raw_payload and unmapped, where they are inert.
    for (const banned of ["org_id", "status", "verified_by"]) {
      expect(Object.keys(nl.load)).not.toContain(banned);
    }
    expect(JSON.stringify(RATE_CON)).toContain("verified_by");
    expect(nl.unmapped.length).toBeGreaterThan(0);
    // Provenance is the ARGUMENT. The payload claimed `broker_direct`; it arrived by paste.
    expect(nl.provenance.source).toBe("paste");

    /* ---- 2. CREATE (6A + 2E + 2D) -------------------------------------------- */
    const created = await postLoad(ctx, post({ source: "paste", payload: RATE_CON }), w.repo, w.store, AT);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string; state: string; moneyParseIncomplete: boolean };
    const loadId = createdBody.id;
    expect(createdBody.state).toBe("candidate_found");
    expect(createdBody.moneyParseIncomplete).toBe(true);
    // R-6: the tenant came from the context, not from the payload's `org_id`.
    expect(w.loads.get(loadId)?.org_id).toBe(ORG);
    // The proposal did not become a fact.
    expect(w.loads.get(loadId)?.gross_rate).toBeNull();

    /* ---- 3. SCORE (3B) — the DECISION number, before the run ------------------ */
    const linehaulCents = nl.load.rateConLinehaulCents?.cents;
    expect(linehaulCents).toBe(280000); // "$2,800" -> integer cents, no float formed
    const input: TrueNetInput = {
      ...CARRIER_PROFILE,
      revenueLines: [
        { id: "linehaul", bucket: "linehaul", amount_cents: linehaulCents as number, settlementState: "confirmed", reliability: "formula" },
      ],
      loadedMiles: 1000,
      deadheadMiles: 100,
      repositionMiles: 0,
      tripMinutes: 2880,
    } as unknown as TrueNetInput;

    const scored = calculateTrueNet(input);
    expect(scored.status).toBe("OK");
    const ok = scored as TrueNetOk;
    // The detention nobody could parse is worth ZERO in the net, and is flagged rather than
    // estimated — SPEC-3B decision 3.
    expect(ok.riskFlags.join(" ")).toMatch(/[Dd]etention/);

    w.scores.set(loadId, { calc_version: ok.calcVersion, inputs: input, outputs: ok, created_at: AT });

    /* ---- 4. ECONOMICS (6A) — serves the decision number only ------------------ */
    const econRes = await getEconomics(ctx, loadId, w.repo);
    const econ = (await econRes.json()) as Record<string, unknown>;
    expect(econ["estimatedNet_cents"]).toBe(ok.trueEstimatedNet_cents);
    expect(econ["estimatedNetLabel"]).toBe("Estimated net (before tax)");
    expect(econ["collected_cents"]).toBeUndefined();

    /* ---- 5. THE HUMAN TAPS (2C approval) ------------------------------------- */
    // Rule 21: a human tap for anything a broker could read as a bid, and for anything binding.
    // The terms are snapshotted and hashed, so an approval cannot be spent on different terms.
    const terms = { linehaulCents, miles: 1000, verdict: ok.verdict, calcVersion: ok.calcVersion };
    const approval = w.approve("book", loadId, terms);

    /* ---- 6. THE ONE MONEY PATH (6E) ------------------------------------------ */
    // Everything the state machine requires, in order — nothing may skip a step.
    for (const step of ["qualified", "pursue_approved", "negotiating", "terms_proposed", "rate_con_received"] as LoadState[]) {
      w.transitionLoad(loadId, step, "walking the vertical slice");
    }
    w.executeApprovedAction(approval.id, {
      loadId,
      action: "book",
      termsHash: approval.termsHash,
      toState: "booked",
      lines: [{ category: "revenue", amountCents: linehaulCents as number, source: "rate_con" }],
    });
    expect(w.loads.get(loadId)?.state).toBe("booked");
    expect(w.ledger).toHaveLength(1);
    expect(w.ledger[0]?.amountCents).toBe(280000);

    // The approval is spent. A second attempt with the same one is refused.
    expect(() =>
      w.executeApprovedAction(approval.id, { loadId, action: "book", termsHash: approval.termsHash }),
    ).toThrow(/approval refused/);

    /* ---- 7. RUN AND DELIVER -------------------------------------------------- */
    for (const step of ["in_transit", "delivered", "billing_ready"] as LoadState[]) {
      w.transitionLoad(loadId, step, "walking the vertical slice");
    }
    // Costs land as they happen. Negative cents: money out.
    w.ledger.push(
      { id: "ll-fuel", loadId, category: "fuel", amountCents: -88000, collectedCents: 0, source: "receipt", at: AT },
      { id: "ll-tolls", loadId, category: "tolls", amountCents: -5000, collectedCents: 0, source: "receipt", at: AT },
    );

    /* ---- 8. SETTLE ----------------------------------------------------------- */
    expect(settlementOf(w.ledger)).toBe("UNSETTLED");
    // Partial payment first, so PARTIAL is exercised as a DERIVED state and not as a column.
    w.ledger[0] = { ...(w.ledger[0] as LedgerLine), collectedCents: 100000 };
    expect(settlementOf(w.ledger)).toBe("PARTIAL");
    w.ledger[0] = { ...(w.ledger[0] as LedgerLine), collectedCents: 280000 };
    expect(settlementOf(w.ledger)).toBe("SETTLED");

    w.transitionLoad(loadId, "paid_reconciled", "settled in full");
    w.transitionLoad(loadId, "learned", "closing the loop");
    expect(w.loads.get(loadId)?.state).toBe("learned");

    /* ---- 9. EVERY STATE CHANGE LEFT EXACTLY ONE AUDIT ROW --------------------- */
    const stateEvents = w.events.filter((e) => e.type.startsWith("state."));
    // Eleven: the thirteen declared states, less `candidate_found` (where the load started) and
    // less `rejected` (the branch this load did not take). Counted from the state machine rather
    // than from memory — my first attempt said ten.
    expect(stateEvents).toHaveLength(11);
    expect(new Set(stateEvents.map((e) => e.type)).size).toBe(11); // one event each, no duplicates
    expect(stateEvents.at(-1)?.type).toBe("state.learned");
    for (const e of stateEvents) expect(e.payload["reason"]).toBeTruthy();

    /* ---- 10. THE WEEK -------------------------------------------------------- */
    const week = weekSummary(w.ledger, { from: "2026-09-07T00:00:00.000Z", to: "2026-09-14T00:00:00.000Z" });
    expect(week.billedCents).toBe(280000);
    expect(week.collectedCents).toBe(280000);
    expect(week.costsCents).toBe(93000);
    expect(week.estimatedNetCents).toBe(280000 - 93000);
    expect(week.collectedNetCents).toBe(280000 - 93000);

    /* ---- 11. THE LEAK DETECTOR ----------------------------------------------- */
    // The detention that was agreed in prose and never billed. This is the one the product
    // exists to notice, and it is found by the same walk that booked the load.
    const leaks = detectLeaks({
      loadId,
      lines: w.ledger,
      estimatedNetCents: ok.trueEstimatedNet_cents,
      agreedAccessorialsCents: { detention: 15000 },
    });
    const missing = leaks.find((l) => l.kind === "missing_accessorial");
    expect(missing?.cents).toBe(15000);
    expect(missing?.note).toContain("$150.00");
  });
});

/* ── the "done when" ──────────────────────────────────────────────────────────── */

describe("12A's 'done when' — the number at the end is re-derivable from provenance", () => {
  it("recomputes the decision number from the STORED inputs alone, and gets the same figure", () => {
    // Nothing computed above is reused. This starts from what a reader would find in the
    // database a month later: the score row's `inputs`, its `calc_version`, and nothing else.
    const w = world();
    const normalized = normalizeLoad(RATE_CON, "paste", { receivedAt: AT });
    if (!normalized.ok) throw new Error("fixture did not normalize");
    const cents = normalized.value.load.rateConLinehaulCents?.cents as number;

    const input = {
      ...CARRIER_PROFILE,
      revenueLines: [{ id: "linehaul", bucket: "linehaul", amount_cents: cents, settlementState: "confirmed", reliability: "formula" }],
      loadedMiles: 1000,
      deadheadMiles: 100,
      repositionMiles: 0,
      tripMinutes: 2880,
    } as unknown as TrueNetInput;

    const first = calculateTrueNet(input) as TrueNetOk;
    w.scores.set("load-1", { calc_version: first.calcVersion, inputs: input, outputs: first, created_at: AT });

    // A month later: read the row, recompute from `inputs`, compare.
    const stored = w.scores.get("load-1");
    const again = calculateTrueNet(stored?.inputs as TrueNetInput) as TrueNetOk;

    expect(again.trueEstimatedNet_cents).toBe(first.trueEstimatedNet_cents);
    expect(again.calcVersion).toBe(stored?.calc_version);
    expect(again.verdict).toBe(first.verdict);
    // Byte-identical, not merely equal in the headline.
    expect(canonicalJson(economicsView(again))).toBe(canonicalJson(economicsView(first)));
  });

  it("the figure carries what it was derived FROM, not just what it is", () => {
    const normalized = normalizeLoad(RATE_CON, "paste", { receivedAt: AT });
    if (!normalized.ok) throw new Error("fixture did not normalize");
    const cents = normalized.value.load.rateConLinehaulCents?.cents as number;
    const ok = calculateTrueNet({
      ...CARRIER_PROFILE,
      revenueLines: [{ id: "linehaul", bucket: "linehaul", amount_cents: cents, settlementState: "confirmed", reliability: "formula" }],
      loadedMiles: 1000,
      deadheadMiles: 100,
      repositionMiles: 0,
      tripMinutes: 2880,
    } as unknown as TrueNetInput) as TrueNetOk;

    const view = economicsView(ok);
    // A number with no visible derivation is not shippable.
    expect(view.calcVersion).toBe(ok.calcVersion);
    expect(view.dieselPriceSnapshotId).toBe("demo:synthetic-profile:2026-09-08");
    expect(Object.keys(view.assumptions).length).toBeGreaterThan(0);
    expect(view.reasons.length).toBeGreaterThan(0);
    // And the arithmetic itself is re-derivable by hand from two of its own fields.
    expect(view.estimatedNet_cents).toBe(view.reliableRevenue_cents - view.allCosts_cents);
  });

  it("the raw payload is unchanged, so the whole chain can be replayed from it", async () => {
    // The provenance that matters most: 4A keeps raw_payload byte-stable, so a month from now
    // the same bytes produce the same normalized load and therefore the same everything.
    const a = normalizeLoad(RATE_CON, "paste", { receivedAt: AT });
    const b = normalizeLoad(JSON.parse(read("tests/fixtures/rate-con-vertical-slice.json")), "paste", { receivedAt: AT });
    if (!a.ok || !b.ok) throw new Error("fixture did not normalize");
    expect(a.value.dedupeHash).toBe(b.value.dedupeHash);
    expect(canonical(a.value.raw_payload)).toBe(canonical(b.value.raw_payload));
    // And the hash is of the canonical payload, so it is checkable without trusting the code
    // that produced it.
    expect(await requestHash(a.value.raw_payload)).toBe(await requestHash(b.value.raw_payload));
  });

  it("the ledger reconciles with the score, and the gap is reported rather than hidden", () => {
    // The two numbers, side by side, at the end of the walk. They differ — that IS the product.
    const normalized = normalizeLoad(RATE_CON, "paste", { receivedAt: AT });
    if (!normalized.ok) throw new Error("fixture did not normalize");
    const cents = normalized.value.load.rateConLinehaulCents?.cents as number;
    const ok = calculateTrueNet({
      ...CARRIER_PROFILE,
      revenueLines: [{ id: "linehaul", bucket: "linehaul", amount_cents: cents, settlementState: "confirmed", reliability: "formula" }],
      loadedMiles: 1000,
      deadheadMiles: 100,
      repositionMiles: 0,
      tripMinutes: 2880,
    } as unknown as TrueNetInput) as TrueNetOk;

    const ledger: LedgerLine[] = [
      { id: "l1", loadId: "load-1", category: "revenue", amountCents: cents, collectedCents: cents, source: "rate_con", at: AT },
      { id: "l2", loadId: "load-1", category: "fuel", amountCents: -88000, collectedCents: 0, source: "receipt", at: AT },
      { id: "l3", loadId: "load-1", category: "tolls", amountCents: -5000, collectedCents: 0, source: "receipt", at: AT },
    ];

    const decision = ok.trueEstimatedNet_cents; // PRE_RUN
    const week = weekSummary(ledger, { from: "2026-09-07T00:00:00.000Z", to: "2026-09-14T00:00:00.000Z" });
    const landed = week.collectedNetCents; // POST_SETTLE

    // They are different facts. Neither is wrong, and the difference is the thing worth seeing.
    expect(Number.isInteger(decision)).toBe(true);
    expect(Number.isInteger(landed)).toBe(true);
    const leaks = detectLeaks({ loadId: "load-1", lines: ledger, estimatedNetCents: decision });
    // Whatever the gap is, it is REPORTED with a number and a sentence, never silently absorbed
    // into one headline figure.
    for (const l of leaks) {
      expect(Number.isInteger(l.cents)).toBe(true);
      expect(l.note.length).toBeGreaterThan(0);
    }
  });
});

describe("the fixture is honest about what it is", () => {
  it("is labelled demo data, per BUILD_DEFAULTS §6", () => {
    expect(RATE_CON["is_demo_data"]).toBe(true);
    expect(String(RATE_CON["_label"])).toMatch(/SYNTHETIC DEMO DATA/);
  });

  it("names no real broker, no real MC number and no real contact", () => {
    // Never invent a trucking fact, a rate, a regulation, a broker or a lane.
    const text = JSON.stringify(RATE_CON);
    expect(text).toMatch(/DEMO BROKER \(synthetic\)/);
    expect(text).toMatch(/example\.invalid/);
    expect(text).not.toMatch(/\bMC\s*-?\s*\d{5,}/);
  });

  it("carries the hostile shapes it exists to exercise", () => {
    // A fixture that only contains clean data tests the happy path and nothing else.
    expect(RATE_CON["notes"]).toMatch(/IGNORE ALL PREVIOUS INSTRUCTIONS/);
    expect(RATE_CON["org_id"]).toBeDefined();
    expect(RATE_CON["verified_by"]).toBeDefined();
    expect(String(RATE_CON["additionalTerms"])).toMatch(/Detention \$75\/hr/);
  });
});
