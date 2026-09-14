/**
 * EZ-BUILD-01 Slice 8 (ticket 6A) — POST /loads, GET /loads/:id, GET /loads/:id/economics.
 *
 * THREE ENDPOINTS AND ONE THAT DOES NOT EXIST. There is no generic state PATCH here and there
 * will not be one: `load.state` moves only through `transition_load()` (Slice 6), and 0003
 * revoked `update (state) on load` from authenticated and anon so nothing else CAN write it.
 * `POST /loads` does not accept a state either — a create that lets the caller choose the
 * starting state is a state PATCH wearing a different verb. The column takes its schema
 * default, `candidate_found`, and the first real move is a transition like any other.
 *
 * WHAT THE CALLER MAY NOT DECIDE, and why it is a list rather than a habit:
 *   org_id      -- comes from the RequestContext, which comes from the user row (R-6).
 *   state       -- above.
 *   id          -- the database mints it. A client-chosen primary key is a client-chosen
 *                  collision, and a client-chosen collision in a tenant table is a way to
 *                  probe for another tenant's rows.
 *   verified_by -- a document cannot grant its own human confirmation (rule 14 / R-5).
 *   created_at  -- provenance is not user input.
 *
 * 4A does the reading, this does the writing, and the seam between them is deliberate: the
 * normalizer returns a `NormalizedLoad`, which is NOT a row. It carries no tenant, no status,
 * no approval and no score. Persistence copies named fields across one at a time; there is no
 * spread of a normalizer result into an insert anywhere in this file, because a spread is how
 * a field nobody reviewed arrives in a table.
 */
import { requireCapability } from "./authz.ts";
import { HttpError, type RequestContext } from "./context.ts";
import { idempotent, type IdempotencyStore } from "./idempotent.ts";
import { normalizeLoad, type LoadSource } from "../../../packages/domain/normalize/index.ts";
import { calculateTrueNet, type TrueNetResult } from "../../../packages/domain/trueNet.ts";

/** The persisted shape this module writes. Every field is named; none is spread. */
export interface LoadInsert {
  readonly org_id: string;
  readonly source: string;
  readonly raw_payload: unknown;
  readonly reference?: string | undefined;
  readonly loaded_miles?: number | undefined;
  readonly weight_lb?: number | undefined;
  readonly commodity?: string | undefined;
}

export interface LoadRow {
  readonly id: string;
  readonly org_id: string;
  readonly state: string;
  readonly source: string;
  readonly reference: string | null;
  readonly gross_rate: number | null;
  readonly loaded_miles: number | null;
  readonly deadhead_miles: number | null;
  readonly created_at: string;
}

export interface StopInsert {
  readonly org_id: string;
  readonly load_id: string;
  readonly seq: number;
  readonly type: string;
  readonly address: string;
  readonly city?: string | undefined;
  readonly state?: string | undefined;
}

/**
 * Every database operation this module needs, injected. Same reasoning as context.ts: this file
 * holds no client, so rule 40 is satisfied structurally rather than by promising to behave.
 *
 * Each reader is TENANT-SCOPED BY ARGUMENT, not by convention — `orgId` is a required parameter
 * on every one of them, so an implementation that forgets the filter does not typecheck into
 * existence quietly. RLS is still the enforcement; this is the layer above it agreeing.
 */
export interface LoadsRepo {
  readonly insertLoad: (row: LoadInsert) => Promise<LoadRow>;
  readonly insertStops: (rows: readonly StopInsert[]) => Promise<void>;
  readonly getLoad: (orgId: string, loadId: string) => Promise<LoadRow | null>;
  /** The most recent calculator run for this load, or null. Never the ledger. */
  readonly getLatestScore: (orgId: string, loadId: string) => Promise<StoredScore | null>;
}

export interface StoredScore {
  readonly calc_version: string;
  readonly inputs: unknown;
  readonly outputs: unknown;
  readonly created_at: string;
}

/** The five sources 4A accepts. A caller cannot invent a sixth. */
const LOAD_SOURCES: readonly LoadSource[] = ["paste", "screenshot", "email", "broker_direct", "manual"];
const isLoadSource = (v: string): v is LoadSource => (LOAD_SOURCES as readonly string[]).includes(v);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* ────────────────────────────────────────────────────────────────────────────
 * POST /loads
 * ──────────────────────────────────────────────────────────────────────────── */

export async function postLoad(
  ctx: RequestContext,
  req: Request,
  repo: LoadsRepo,
  store: IdempotencyStore,
  /** Injected so the result is reproducible in a test; 4A refuses a non-ISO value itself. */
  receivedAt: string,
): Promise<Response> {
  requireCapability(ctx, "load.create");

  return idempotent(ctx, req, "loads.create", store, async (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "body must be a JSON object", "Malformed request body.");
    }
    const envelope = body as { source?: unknown; payload?: unknown };

    // The SOURCE is an argument, never a payload field. 4A's acceptance 10 is the same rule one
    // layer down: a payload claiming `source: "broker_direct"` does not become provenance.
    const source = envelope.source;
    if (typeof source !== "string") {
      throw new HttpError(400, "source is required", "A source is required.");
    }

    if (!isLoadSource(source)) {
      throw new HttpError(400, `unknown source ${source}`, "Unknown source.");
    }

    const result = normalizeLoad(envelope.payload, source, { receivedAt });
    if (!result.ok) {
      // Not an error: a fact is missing and a human is being asked for it. 202 rather than 400,
      // because the request was well formed and nothing about it was wrong. `partial` is
      // returned so the caller can show what WAS read — but nothing is persisted, because a
      // half-read load in the table is a load somebody will later trust.
      return json(
        {
          status: "NEEDS_INPUT",
          fields: result.fields,
          message: "Some facts could not be read from this load. Confirm them and resubmit.",
        },
        202,
      );
    }

    const normalized = result.value;

    // Named field by named field. NO SPREAD — a spread is how a field nobody reviewed arrives
    // in a table, and 4A's denylist guarantees what it did not MAP, not what a careless caller
    // copies afterwards.
    const row = await repo.insertLoad({
      org_id: ctx.orgId, // R-6: from identity, never from the body
      source, // the argument, not the payload (4A acceptance 10, one layer down)
      raw_payload: normalized.raw_payload, // inert data, never instructions (rule 3)
      // The first reference number, as text. `referenceNumbers` is UntrustedText[] and stays
      // marked untrusted inside raw_payload; only its `.value` is stored in the plain column.
      reference: normalized.load.referenceNumbers[0]?.value,
      // gross_rate is deliberately NOT set. 4A produces `rateConLinehaulCents` as ProposedMoney
      // — a proposal with an origin and no verified_by. Copying a proposal into the load's
      // money column would make it a fact, which is exactly rule 14 and R-5. It stays in
      // raw_payload until a human confirms it through the deal path.
      loaded_miles: normalized.load.miles?.value,
      weight_lb: normalized.load.weightLbs,
      commodity: normalized.load.commodity?.value,
    });

    if (normalized.stops.length > 0) {
      // The order is 4A's, not this module's opinion: `seq` comes off the stop 4A produced. If
      // 4A could not order them it says so and does not guess, and this never renumbers.
      await repo.insertStops(
        normalized.stops.map((s) => ({
          org_id: ctx.orgId,
          load_id: row.id,
          seq: s.seq,
          type: s.type,
          address: s.location.raw.value,
          city: s.location.city,
          state: s.location.state,
        })),
      );
    }

    return json(
      {
        id: row.id,
        state: row.state,
        dedupeHash: normalized.dedupeHash,
        moneyParseIncomplete: normalized.moneyParseIncomplete,
        unmapped: normalized.unmapped,
        // Said plainly on the way out, because it is what a driver would otherwise assume:
        // nothing here has been priced or agreed, and no money has been written anywhere.
        note: "Created. No rate has been agreed and no money has been recorded.",
      },
      201,
    );
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * GET /loads/:id
 * ──────────────────────────────────────────────────────────────────────────── */

export async function getLoad(ctx: RequestContext, loadId: string, repo: LoadsRepo): Promise<Response> {
  requireCapability(ctx, "load.read");
  const row = await repo.getLoad(ctx.orgId, loadId);
  if (row === null) {
    // 404, NOT 403. Under RLS a cross-tenant read returns zero rows, and the API must not turn
    // that into a different answer than "no such load" — a 403 tells the caller the id exists
    // somewhere, which is exactly the fact tenant isolation is keeping from them.
    throw new HttpError(404, "load not found or not this tenant's", "No such load.");
  }
  return json(row);
}

/* ────────────────────────────────────────────────────────────────────────────
 * GET /loads/:id/economics
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The decision number, and nothing about what landed.
 *
 * R-7, ruled in COWORK-TO-CODE 08:05 UTC Sep 12 and not re-opened here: there are TWO numbers —
 * one for the decision before the run, one for what actually settled — and the verdict reads
 * only the first. This endpoint serves only the first. It does not read the ledger, it is not
 * given a way to read the ledger (`LoadsRepo` has no ledger method at all), and the shape it
 * returns carries no settled, collected or paid field. 6E owns the other number.
 *
 * The labels are R-4's: "estimated net (before tax)". Never "keep", never "take-home", never a
 * promise. The product estimates; it does not promise (R-10).
 */
export const ECONOMICS_LABEL = "Estimated net (before tax)";

/** Fields that would mean "this is what landed". None of them may appear in this response. */
export const SETTLEMENT_FIELDS = [
  "collected_cents",
  "collectedCents",
  "paid_cents",
  "paidCents",
  "settled_cents",
  "settledCents",
  "actual_net_cents",
  "actualNetCents",
] as const;

export async function getEconomics(ctx: RequestContext, loadId: string, repo: LoadsRepo): Promise<Response> {
  requireCapability(ctx, "load.read");

  const load = await repo.getLoad(ctx.orgId, loadId);
  if (load === null) throw new HttpError(404, "load not found or not this tenant's", "No such load.");

  const stored = await repo.getLatestScore(ctx.orgId, loadId);
  if (stored === null) {
    return json(
      {
        status: "NOT_SCORED",
        message: "This load has not been scored yet.",
      },
      200,
    );
  }

  const outputs = stored.outputs as TrueNetResult;
  if (outputs.status === "NEEDS_INPUT") {
    // Fail closed, and say which facts. 3B's rule 3: never a default, never an estimate.
    return json({
      status: "NEEDS_INPUT",
      calcVersion: outputs.calcVersion,
      missing: outputs.missing,
      message: "Some facts are missing, so no figure is shown. Nothing has been estimated in their place.",
    });
  }

  return json(economicsView(outputs));
}

/**
 * The serialisable view. Exported so a test can assert the SHAPE without a repo, and so the
 * "no settlement field" rule is checkable on the value rather than on a code path.
 */
export function economicsView(r: Extract<TrueNetResult, { status: "OK" }>) {
  return {
    status: "OK" as const,
    calcVersion: r.calcVersion,
    dieselPriceSnapshotId: r.dieselPriceSnapshotId,

    /** The decision number. Reliable revenue minus all costs. */
    estimatedNet_cents: r.trueEstimatedNet_cents,
    estimatedNetLabel: ECONOMICS_LABEL,

    verdict: r.verdict,
    reasons: r.reasons,
    riskFlags: r.riskFlags,
    missingFacts: r.missingFacts,
    /** "calculated from: ..." — a number with no visible derivation is not shippable. */
    assumptions: r.assumptions,

    /* The three revenue partitions, each labelled for what it is. Reported, not netted. */
    reliableRevenue_cents: r.reliableRevenue_cents,
    atRiskAccessorialRevenue_cents: r.atRiskAccessorialRevenue_cents,
    unconfirmedRevenue_cents: r.unconfirmedRevenue_cents,
    grossRevenue_cents: r.grossRevenue_cents,
    upsideIfAllAccessorialsPay_cents: r.upsideIfAllAccessorialsPay_cents,

    allCosts_cents: r.allCosts_cents,
    allInRpm_millicents_per_mile: r.allInRpm_millicents_per_mile,
    netPerAvailableDay_cents: r.netPerAvailableDay_cents,

    breakEvenRate_cents: r.breakEvenRate_cents,
    floorRate_cents: r.floorRate_cents,
    recommendedBid_cents: r.recommendedBid_cents,
  };
}

/** Re-exported so a caller scoring a load uses the same calculator this endpoint reads. */
export { calculateTrueNet };
