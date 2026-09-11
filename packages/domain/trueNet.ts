/**
 * True-Net calculator — SPEC 3B (reviews/backend/3-core-domain/SPEC-3B-TRUENET-CONTRACT.md).
 *
 * The number that tells a driver what they actually keep. It is the one thing
 * this app cannot be confidently wrong about, so everything here is ordinary
 * deterministic TypeScript: no model, no network, no clock, no randomness.
 * Same input, same output, forever — that is what lets a stored verdict be
 * re-derived months later and audited against the version that produced it.
 *
 * CONTRACT AUTHORITY: this file implements SPEC-3B. Where `02-ARCHITECTURE.md`
 * differs it is SUPERSEDED (stamped 2026-09-11) — it specified float `number`
 * fields, a two-bucket revenue model and probability-weighted detention, all
 * three of which SPEC-3B overrules and explains.
 *
 * Rule 2: money math is deterministic TypeScript with tests, never a model.
 * The pipeline around this function is
 *   LLM extracts → server validates → THIS → validated result → LLM verbalizes.
 * A model never produces a dollar figure; it only reads one back out.
 *
 * ── Integer cents, everywhere ────────────────────────────────────────────────
 * No floats touch the money path. Floats accumulate representation error across
 * the ~15 arithmetic steps below, so two loads with identical inputs could
 * differ by a cent depending on operation order — which makes "20 golden loads
 * to the cent" unachievable and a stored verdict non-reproducible.
 *
 * Quantities that are genuinely fractional are carried as scaled integers so
 * that the division happens exactly once, at the end, under `divRound`:
 *   - fuel economy  → `_milli` mpg    (6.5 mpg = 6500)
 *   - percentages   → `_bp`           (basis points; 25% = 2500)
 *   - trip duration → `tripMinutes`   (whole minutes, not fractional hours)
 */

/**
 * Stamped on every result alongside the full input set, so a stored verdict can
 * be re-derived and a regression cannot silently rewrite history.
 *
 * BUMP THIS whenever a definition changes in a way that could move a number.
 * Adding a field that cannot change an existing figure does not require a bump.
 */
/**
 * 3B.2.0 — SPEC-3B Revision 2 (F-1/F-2/F-3). The RESULT SHAPE changed:
 * trueEstimatedNet_cents is now derived from reliable revenue only, and three
 * revenue fields plus two clock fields were added. A 3B.1.0 result and a 3B.2.0
 * result are not comparable and must never be mixed silently in the ledger.
 */
export const CALC_VERSION = "3B.2.0";

export type Verdict = "take" | "negotiate" | "skip";

/**
 * How the driver is paid.
 *
 * SPEC-3B decision 2: a percentage applies to LINEHAUL ONLY. Fuel surcharge and
 * accessorials are pass-throughs or separately negotiated, and we do not assume
 * a pay percentage reaches them without an explicit contract rule. Carrier
 * overrides that widen the basis are permitted by the spec but require a full
 * override record — see the closing note in this file.
 */
export type DriverPay =
  | { readonly type: "none" }
  | { readonly type: "percent"; readonly percent_bp: number }
  | { readonly type: "perMile"; readonly rate_cents_per_mile: number };

/**
 * Every input the calculator reads. All money is integer cents; all percentages
 * are integer basis points; all distances are whole miles.
 *
 * The three revenue buckets are MUTUALLY EXCLUSIVE AND EXHAUSTIVE. This is
 * functional, not cosmetic: decisions 2 and 4 put driver percentage and the
 * broker/dispatch haircut on linehaul only, which requires knowing exactly which
 * dollars are linehaul and which are pass-throughs.
 *
 * Any future revenue line MUST declare which ONE bucket it belongs to. The
 * source proposal for this spec double-counted precisely here — it had fuel
 * surcharge and lumper inside both "accessorials" and `passThroughRevenue`,
 * which would have inflated every gross figure on a driver's screen.
 */
export interface TrueNetInput {
  /** Negotiated base freight rate ONLY. Excludes fuel surcharge, lumper, detention, stop pay, layover, TONU. */
  readonly linehaulRevenue_cents: number;
  /** Confirmed fuel surcharge + confirmed lumper reimbursement + confirmed reimbursable expenses. */
  readonly passThroughRevenue_cents: number;
  /** Confirmed detention + stop pay + layover + TONU + any other CONFIRMED accessorial not already a pass-through. */
  readonly otherAccessorialRevenue_cents: number;

  readonly loadedMiles: number;
  readonly deadheadMiles: number;
  readonly repositionMiles: number;

  /** Fuel economy in thousandths of a mile per gallon. 6.5 mpg = 6500. Must be > 0. */
  readonly mpgLoaded_milli: number;
  readonly mpgEmpty_milli: number;

  /** Posted pump price, integer cents per gallon. */
  readonly regionalDieselPrice_cents_per_gal: number;
  /**
   * SPEC-3B decision 1: DOLLARS OFF PER GALLON, expressed in cents off per
   * gallon — not a percentage. Fuel-card programs quote dollars off posted pump
   * price, and this matches the Settings field already shipped.
   */
  readonly fuelDiscount_cents_per_gal: number;

  readonly tolls_cents: number;
  readonly maintenanceReserve_cents_per_mile: number;
  readonly tireReserve_cents_per_mile: number;
  readonly knownExpenses_cents: number;

  /** Whole minutes. Integer by construction, so overhead needs no fractional-hour math. */
  readonly tripMinutes: number;
  readonly overhead_cents_per_day: number;

  readonly driverPay: DriverPay;
  /** SPEC-3B decision 4: applied to LINEHAUL ONLY. Lumper and fuel surcharge are not commissionable absent an explicit agreement. */
  readonly brokerOrDispatchHaircut_bp: number;

  /**
   * SPEC-3B decision 5: the carrier's OWN break-even and target, derived from
   * their Settings cost numbers. Never a global app-wide dollar threshold — a
   * fixed "counter for $300 more" was explicitly rejected in the Gill22 research
   * and would be wrong for every driver but one.
   */
  readonly breakEven_cents_per_mile: number;
  readonly target_cents_per_mile: number;

  /**
   * Whether detention terms/hours are known for this load.
   *
   * SPEC-3B decision 3: when this is false or absent, detention contributes
   * EXACTLY 0 cents to the net — no weighting, no expected value, no
   * "conservative" fraction. It is surfaced as a risk flag and a missing fact
   * instead. Confirmed detention from a rate con is real revenue and belongs in
   * `otherAccessorialRevenue_cents` like any other confirmed accessorial; the
   * ban is on ESTIMATING, not on counting confirmed.
   */
  readonly detentionTermsKnown?: boolean;

  /**
   * Rev 2 (F-2): how much of the driver's 11-hour drive clock this load consumes,
   * in WHOLE MINUTES (same integer convention as `tripMinutes`). Optional and
   * never defaulted: when absent, the two clock outputs report NEEDS_INPUT and
   * the verdict is unaffected. 3B does NOT price the clock — inventing an hourly
   * opportunity cost is the same class of error as estimating detention. 3E
   * decides its weight, against real data.
   */
  readonly clockMinutesConsumed?: number;
}

export interface TrueNetOk {
  readonly status: "OK";
  readonly calcVersion: string;
  /** The full input set, echoed so the result can be re-derived independently. */
  readonly input: TrueNetInput;

  readonly linehaulRevenue_cents: number;
  readonly passThroughRevenue_cents: number;
  readonly otherAccessorialRevenue_cents: number;
  /** Still the correct all-in total; 6E reconciles booked-vs-paid against it. NOT the verdict's basis. */
  readonly grossRevenue_cents: number;

  /**
   * Rev 2 (F-1): "confirmed on a rate con" and "actually paid" are different
   * things. reliable = linehaul + pass-throughs — the money that arrives if the
   * load is delivered. at-risk = otherAccessorialRevenue — detention, stop pay,
   * layover, TONU: confirmed on paper, routinely denied or disputed after the
   * fact. The net and the verdict see ONLY the reliable figure; at-risk is
   * reported separately and always labelled; upside is display-only.
   */
  readonly reliableRevenue_cents: number;
  readonly atRiskAccessorialRevenue_cents: number;
  readonly upsideIfAllAccessorialsPay_cents: number;

  readonly loadedMiles: number;
  readonly emptyMiles: number;
  readonly totalMiles: number;

  readonly effectiveDieselPrice_cents_per_gal: number;
  readonly fuelCost_cents: number;
  readonly maintenanceReserve_cents: number;
  readonly tireReserve_cents: number;
  readonly tolls_cents: number;
  readonly knownExpenses_cents: number;
  readonly overhead_cents: number;
  readonly driverPay_cents: number;
  readonly brokerOrDispatchHaircut_cents: number;

  readonly trueTripCost_cents: number;
  readonly trueEstimatedNet_cents: number;

  /** All-in revenue per mile, in THOUSANDTHS of a cent, so the verdict comparison keeps its precision. */
  readonly allInRpm_millicents_per_mile: number;
  readonly netPerAvailableDay_cents: number;

  /**
   * Rev 2 (F-2): reported outputs only — 3B does not price the clock. Hours in
   * THOUSANDTHS (integer, like mpg_milli), derived from `clockMinutesConsumed`.
   * Both are the literal string NEEDS_INPUT when the minutes are unknown: never
   * a default, never substituted into the verdict. Per-field, not whole-result,
   * because an unknown clock must not block a load from being priced.
   */
  readonly clockHoursConsumed_milli: number | "NEEDS_INPUT";
  readonly netPerAvailableHour_cents: number | "NEEDS_INPUT";

  /** Trip-level revenue needed to reach the carrier's own break-even / target. */
  readonly breakEvenRate_cents: number;
  readonly floorRate_cents: number;
  readonly recommendedBid_cents: number;

  readonly verdict: Verdict;
  /** Why the verdict came out this way, in the order the rules fired. */
  readonly reasons: readonly string[];
  /** Things the driver should see but that are worth ZERO cents in the net. */
  readonly riskFlags: readonly string[];
  /** Facts we do not have. Never silently defaulted. */
  readonly missingFacts: readonly string[];
  /** The "calculated from: …" line — a number with no visible derivation is not shippable (3E item F). */
  readonly assumptions: Readonly<Record<string, string>>;
}

/**
 * Returned instead of a number when a required input is absent.
 *
 * SPEC-3B rule 3, fail closed: never a default, never an estimate. The caller
 * gets the field names back and asks the human.
 */
export interface TrueNetNeedsInput {
  readonly status: "NEEDS_INPUT";
  readonly calcVersion: string;
  readonly missing: readonly string[];
}

export type TrueNetResult = TrueNetOk | TrueNetNeedsInput;

/** Thrown by the NaN guard. A non-finite intermediate must never propagate into a dollar figure. */
export class TrueNetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrueNetError";
  }
}

/* ── integer helpers ───────────────────────────────────────────────────────── */

/**
 * Divide two integers and round half away from zero, without ever forming a
 * float from the money values. `Math.round(a / b)` would round half toward
 * +Infinity and would also put the money path through a float, which is what
 * this whole module avoids.
 */
function divRound(numerator: number, denominator: number): number {
  if (denominator === 0) throw new TrueNetError("division by zero");
  const negative = numerator < 0 !== denominator < 0;
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor(n / d);
  const remainder = n - q * d;
  const rounded = remainder * 2 >= d ? q + 1 : q;
  return negative ? -rounded : rounded;
}

/** SPEC-3B rule 4. Any non-finite intermediate throws rather than propagating. */
function guard(label: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new TrueNetError(`${label} is not finite`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new TrueNetError(`${label} is not a safe integer: ${value}`);
  }
  return value;
}

/* ── validation ────────────────────────────────────────────────────────────── */

const REQUIRED_INTEGER_FIELDS = [
  "linehaulRevenue_cents",
  "passThroughRevenue_cents",
  "otherAccessorialRevenue_cents",
  "loadedMiles",
  "deadheadMiles",
  "repositionMiles",
  "mpgLoaded_milli",
  "mpgEmpty_milli",
  "regionalDieselPrice_cents_per_gal",
  "fuelDiscount_cents_per_gal",
  "tolls_cents",
  "maintenanceReserve_cents_per_mile",
  "tireReserve_cents_per_mile",
  "knownExpenses_cents",
  "tripMinutes",
  "overhead_cents_per_day",
  "brokerOrDispatchHaircut_bp",
  "breakEven_cents_per_mile",
  "target_cents_per_mile",
] as const;

/** Fields where a zero is a missing fact rather than a valid value. */
const MUST_BE_POSITIVE = new Set<string>([
  "mpgLoaded_milli",
  "mpgEmpty_milli",
  "regionalDieselPrice_cents_per_gal",
  "tripMinutes",
  "breakEven_cents_per_mile",
  "target_cents_per_mile",
]);

function collectMissing(input: Partial<TrueNetInput>): string[] {
  const missing: string[] = [];

  for (const field of REQUIRED_INTEGER_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) {
      missing.push(field);
      continue;
    }
    // A non-finite or non-integer VALUE is a broken caller, not a missing fact,
    // so it throws rather than coming back as NEEDS_INPUT.
    if (!Number.isFinite(value)) {
      throw new TrueNetError(`${field} is not finite`);
    }
    if (!Number.isInteger(value)) {
      throw new TrueNetError(`${field} must be an integer (got ${String(value)})`);
    }
    if (value < 0) {
      throw new TrueNetError(`${field} must not be negative (got ${String(value)})`);
    }
    if (MUST_BE_POSITIVE.has(field) && value === 0) {
      missing.push(field);
    }
  }

  const pay = input.driverPay;
  if (pay === undefined || pay === null) {
    missing.push("driverPay");
  } else if (pay.type === "percent") {
    if (!Number.isInteger(pay.percent_bp)) {
      throw new TrueNetError("driverPay.percent_bp must be an integer");
    }
    if (pay.percent_bp < 0) throw new TrueNetError("driverPay.percent_bp must not be negative");
  } else if (pay.type === "perMile") {
    if (!Number.isInteger(pay.rate_cents_per_mile)) {
      throw new TrueNetError("driverPay.rate_cents_per_mile must be an integer");
    }
    if (pay.rate_cents_per_mile < 0) {
      throw new TrueNetError("driverPay.rate_cents_per_mile must not be negative");
    }
  }

  return missing;
}

/* ── the calculator ────────────────────────────────────────────────────────── */

/**
 * Fuel for one leg, in integer cents.
 *
 * gallons = miles / mpg, and mpg is carried in thousandths, so
 *   gallons = miles * 1000 / mpg_milli
 * and the cost is that times the effective price. Both are folded into a single
 * `divRound`, so exactly one rounding happens per leg.
 */
function legFuelCost_cents(miles: number, mpg_milli: number, price_cents_per_gal: number): number {
  return divRound(miles * 1000 * price_cents_per_gal, mpg_milli);
}

export function calculateTrueNet(input: Partial<TrueNetInput>): TrueNetResult {
  const missing = collectMissing(input);
  if (missing.length > 0) {
    return { status: "NEEDS_INPUT", calcVersion: CALC_VERSION, missing };
  }

  const i = input as TrueNetInput;

  /* Revenue — three mutually exclusive buckets, summed once. */
  const grossRevenue_cents = guard(
    "grossRevenue_cents",
    i.linehaulRevenue_cents + i.passThroughRevenue_cents + i.otherAccessorialRevenue_cents,
  );

  /* Distance. Deadhead and reposition are both run empty, so they share mpgEmpty. */
  const emptyMiles = guard("emptyMiles", i.deadheadMiles + i.repositionMiles);
  const totalMiles = guard("totalMiles", i.loadedMiles + emptyMiles);
  if (totalMiles === 0) {
    throw new TrueNetError("totalMiles is zero — a load with no distance cannot be priced");
  }

  /* Fuel. Decision 1: the discount is dollars (cents) off the posted price. */
  const effectiveDieselPrice_cents_per_gal = guard(
    "effectiveDieselPrice_cents_per_gal",
    i.regionalDieselPrice_cents_per_gal - i.fuelDiscount_cents_per_gal,
  );
  if (effectiveDieselPrice_cents_per_gal < 0) {
    throw new TrueNetError("fuel discount exceeds the posted diesel price");
  }
  const fuelCost_cents = guard(
    "fuelCost_cents",
    legFuelCost_cents(i.loadedMiles, i.mpgLoaded_milli, effectiveDieselPrice_cents_per_gal) +
      legFuelCost_cents(emptyMiles, i.mpgEmpty_milli, effectiveDieselPrice_cents_per_gal),
  );

  /* Per-mile reserves apply to every mile the truck turns, loaded or empty. */
  const maintenanceReserve_cents = guard(
    "maintenanceReserve_cents",
    i.maintenanceReserve_cents_per_mile * totalMiles,
  );
  const tireReserve_cents = guard("tireReserve_cents", i.tireReserve_cents_per_mile * totalMiles);

  /* Overhead is a daily figure prorated across the trip. 1440 minutes to a day. */
  const overhead_cents = guard(
    "overhead_cents",
    divRound(i.overhead_cents_per_day * i.tripMinutes, 1440),
  );

  /*
   * ROUNDING RULE — SPEC-3B Rev 2, F-3. Every percentage multiply in the money
   * path: (a) rounds HALF-UP, AWAY FROM ZERO (divRound, not Math.round, which
   * rounds half toward +Infinity and would put money through a float); (b) is
   * computed INDEPENDENTLY from linehaulRevenue_cents — never chained off a
   * previously rounded subtotal, so two multiplies can never compound a cent.
   * Asserted by the half-cent golden case. Any future percentage line must
   * follow this rule and say so here.
   */

  /* Decision 2: a percentage pays on LINEHAUL ONLY. Per-mile pays on every mile. */
  let driverPayRaw: number;
  switch (i.driverPay.type) {
    case "none":
      driverPayRaw = 0;
      break;
    case "percent":
      // F-3: independent multiply from linehaul, half-up via divRound.
      driverPayRaw = divRound(i.linehaulRevenue_cents * i.driverPay.percent_bp, 10_000);
      break;
    case "perMile":
      driverPayRaw = i.driverPay.rate_cents_per_mile * totalMiles;
      break;
  }
  const driverPay_cents = guard("driverPay_cents", driverPayRaw);

  /* Decision 4: the haircut is on LINEHAUL ONLY. F-3: independent multiply, half-up. */
  const brokerOrDispatchHaircut_cents = guard(
    "brokerOrDispatchHaircut_cents",
    divRound(i.linehaulRevenue_cents * i.brokerOrDispatchHaircut_bp, 10_000),
  );

  const trueTripCost_cents = guard(
    "trueTripCost_cents",
    fuelCost_cents +
      i.tolls_cents +
      maintenanceReserve_cents +
      tireReserve_cents +
      i.knownExpenses_cents +
      overhead_cents +
      driverPay_cents +
      brokerOrDispatchHaircut_cents,
  );

  /*
   * Rev 2 (F-1): "confirmed" is not "paid". The net a driver acts on is built
   * from RELIABLE revenue only — linehaul plus pass-throughs. Confirmed
   * accessorials (detention, stop pay, layover, TONU) are reported as at-risk
   * and never summed into the headline. This is decision 3 extended one step:
   * decision 3 banned estimating detention hours; this bans banking confirmed-
   * but-unsettled dollars. Same principle, same reason. grossRevenue_cents stays
   * as the true all-in total for 6E's booked-vs-paid reconciliation.
   */
  const reliableRevenue_cents = guard(
    "reliableRevenue_cents",
    i.linehaulRevenue_cents + i.passThroughRevenue_cents,
  );
  const atRiskAccessorialRevenue_cents = guard(
    "atRiskAccessorialRevenue_cents",
    i.otherAccessorialRevenue_cents,
  );

  const trueEstimatedNet_cents = guard(
    "trueEstimatedNet_cents",
    reliableRevenue_cents - trueTripCost_cents,
  );
  /* Display-only, always labelled, never the headline and never in the verdict. */
  const upsideIfAllAccessorialsPay_cents = guard(
    "upsideIfAllAccessorialsPay_cents",
    trueEstimatedNet_cents + atRiskAccessorialRevenue_cents,
  );

  const allInRpm_millicents_per_mile = guard(
    "allInRpm_millicents_per_mile",
    divRound(grossRevenue_cents * 1000, totalMiles),
  );
  const netPerAvailableDay_cents = guard(
    "netPerAvailableDay_cents",
    divRound(trueEstimatedNet_cents * 1440, i.tripMinutes),
  );

  /*
   * Rev 2 (F-2): the clock is REPORTED, not priced. Both outputs are NEEDS_INPUT
   * when the minutes are unknown — never a default — and neither enters the
   * verdict. Their weight is 3E's decision, against real data.
   */
  const clockKnown =
    typeof i.clockMinutesConsumed === "number" &&
    Number.isSafeInteger(i.clockMinutesConsumed) &&
    i.clockMinutesConsumed > 0;
  const clockHoursConsumed_milli: number | "NEEDS_INPUT" = clockKnown
    ? guard("clockHoursConsumed_milli", divRound((i.clockMinutesConsumed as number) * 1000, 60))
    : "NEEDS_INPUT";
  const netPerAvailableHour_cents: number | "NEEDS_INPUT" = clockKnown
    ? guard(
        "netPerAvailableHour_cents",
        divRound(trueEstimatedNet_cents * 60, i.clockMinutesConsumed as number),
      )
    : "NEEDS_INPUT";

  /* Decision 5: thresholds are the carrier's own, scaled to this trip's miles. */
  const breakEvenRate_cents = guard("breakEvenRate_cents", i.breakEven_cents_per_mile * totalMiles);
  const recommendedBid_cents = guard("recommendedBid_cents", i.target_cents_per_mile * totalMiles);
  const floorRate_cents = breakEvenRate_cents;

  /* Decision 3: detention is never estimated into the net. Flag it instead. */
  const riskFlags: string[] = [];
  const missingFacts: string[] = [];
  if (i.detentionTermsKnown !== true) {
    riskFlags.push("Detention terms/hours unknown — not included in estimated net.");
    missingFacts.push("detentionTermsKnown");
  }
  if (atRiskAccessorialRevenue_cents > 0) {
    riskFlags.push(
      `${atRiskAccessorialRevenue_cents}c of confirmed accessorials is at risk until paid — not in the estimated net.`,
    );
  }
  // The clock is deliberately NOT a missingFact: missingFacts drive the
  // "net is conservative by construction" confidence line, and an unknown clock
  // does not touch the net. The per-field NEEDS_INPUT on the two clock outputs
  // is the only place it is reported.

  /*
   * Rev 2 (F-1, ruling 4): the verdict evaluates the RELIABLE figure only. A
   * load must not read "Take" on the strength of detention that may never be
   * paid, so at-risk dollars are structurally absent from every comparison
   * below: the net is reliable-minus-costs, and the threshold comparisons use
   * reliableRevenue_cents, never grossRevenue_cents.
   */
  const reasons: string[] = [];
  let verdict: Verdict;
  if (trueEstimatedNet_cents <= 0) {
    verdict = "skip";
    reasons.push("Estimated net (reliable revenue less all costs) is zero or negative.");
  } else if (reliableRevenue_cents >= recommendedBid_cents) {
    verdict = "take";
    reasons.push("Reliable revenue meets or beats your target rate for these miles.");
  } else if (reliableRevenue_cents >= breakEvenRate_cents) {
    verdict = "negotiate";
    reasons.push("Reliable revenue clears your break-even but falls short of your target.");
    reasons.push("Counter toward your target; your floor is your break-even.");
  } else {
    verdict = "skip";
    reasons.push("Reliable revenue does not clear your break-even for these miles.");
  }
  if (atRiskAccessorialRevenue_cents > 0) {
    reasons.push("Confirmed accessorials were not counted toward this verdict — they are at risk until paid.");
  }
  if (riskFlags.length > 0) {
    reasons.push("Unknown facts are excluded from the net rather than estimated.");
  }

  const assumptions: Record<string, string> = {
    calculatedFrom:
      `${totalMiles} total miles (${i.loadedMiles} loaded + ${emptyMiles} empty), ` +
      `fuel at ${effectiveDieselPrice_cents_per_gal}c/gal effective ` +
      `(${i.regionalDieselPrice_cents_per_gal}c posted less ${i.fuelDiscount_cents_per_gal}c card discount)`,
    fuelDiscountBasis: "dollars off per gallon (SPEC-3B decision 1)",
    driverPayBasis:
      i.driverPay.type === "percent"
        ? "percentage of linehaul revenue only (SPEC-3B decision 2)"
        : i.driverPay.type === "perMile"
          ? "per mile, all miles"
          : "no driver pay line",
    detentionBasis:
      i.detentionTermsKnown === true
        ? "confirmed detention counted in otherAccessorialRevenue_cents"
        : "0 cents — detention terms unknown and never estimated (SPEC-3B decision 3)",
    haircutBasis: "percentage of linehaul revenue only (SPEC-3B decision 4)",
    netBasis:
      "reliable revenue (linehaul + pass-throughs) less all costs; confirmed accessorials excluded until paid (SPEC-3B Rev 2, F-1)",
    atRiskBasis:
      atRiskAccessorialRevenue_cents > 0
        ? `${atRiskAccessorialRevenue_cents}c confirmed but unsettled — shown separately, never in the net or the verdict`
        : "no confirmed accessorials on this load",
    clockBasis: clockKnown
      ? "clock hours reported only — 3B does not price the driver's clock (SPEC-3B Rev 2, F-2)"
      : "clock hours unknown — reported as NEEDS_INPUT, never defaulted, not in the verdict (SPEC-3B Rev 2, F-2)",
    roundingBasis:
      "half-up, away from zero, on each percentage multiply, each computed independently from linehaul (SPEC-3B Rev 2, F-3)",
    verdictBasis:
      `your own break-even ${i.breakEven_cents_per_mile}c/mi and target ` +
      `${i.target_cents_per_mile}c/mi, not a global threshold (SPEC-3B decision 5); ` +
      "evaluated on reliable revenue and the reliable net only (Rev 2, F-1)",
    confidence:
      missingFacts.length === 0
        ? "All inputs confirmed."
        : `Excludes ${missingFacts.length} unknown fact(s); the net is conservative by construction.`,
  };

  return {
    status: "OK",
    calcVersion: CALC_VERSION,
    input: i,
    linehaulRevenue_cents: i.linehaulRevenue_cents,
    passThroughRevenue_cents: i.passThroughRevenue_cents,
    otherAccessorialRevenue_cents: i.otherAccessorialRevenue_cents,
    grossRevenue_cents,
    reliableRevenue_cents,
    atRiskAccessorialRevenue_cents,
    upsideIfAllAccessorialsPay_cents,
    loadedMiles: i.loadedMiles,
    emptyMiles,
    totalMiles,
    effectiveDieselPrice_cents_per_gal,
    fuelCost_cents,
    maintenanceReserve_cents,
    tireReserve_cents,
    tolls_cents: i.tolls_cents,
    knownExpenses_cents: i.knownExpenses_cents,
    overhead_cents,
    driverPay_cents,
    brokerOrDispatchHaircut_cents,
    trueTripCost_cents,
    trueEstimatedNet_cents,
    allInRpm_millicents_per_mile,
    netPerAvailableDay_cents,
    clockHoursConsumed_milli,
    netPerAvailableHour_cents,
    breakEvenRate_cents,
    floorRate_cents,
    recommendedBid_cents,
    verdict,
    reasons,
    riskFlags,
    missingFacts,
    assumptions,
  };
}

/*
 * Deliberately NOT implemented in 3B core, and flagged rather than half-built:
 *
 * - Carrier-specific overrides (driver percentage on linehaul + fuel surcharge,
 *   dispatch fee on total gross, carrier-approved detention schedules). SPEC-3B
 *   permits them but requires a full override record — effective date, approver,
 *   contract source, visible Load Card explanation, calculator version, revert
 *   path — and says an override missing any field is not applied. The record IS
 *   the feature; a bare basis flag would be exactly the inferred behaviour the
 *   spec forbids, so it waits for the data model.
 * - The 150–300 case rate-floor/negotiation corpus required pre-pilot by 7-TEST
 *   (Grok's stricter number governs). The 20 golden loads are the 3B gate, not
 *   that corpus.
 */
