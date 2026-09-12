/**
 * True-Net calculator — SPEC 3B, Revision 3 (ticket 3B-R4).
 *
 * Contract sources, in authority order:
 *   reviews/backend/3-core-domain/SPEC-3B-REV3-DELTA.md       (Rev 3 — this revision)
 *   reviews/backend/3-core-domain/SPEC-3B-TRUENET-CONTRACT.md (Rev 1/2 base, still standing)
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
 * ── The Rev 3 class fix (3B-R4) ──────────────────────────────────────────────
 * Three Rev-2 findings — lumper reimbursement banked as reliable (F-4), an
 * unconfirmed fuel surcharge falling through every bucket including gross (F-5),
 * and "reimbursables" as an unbounded third category name (F-6) — are the same
 * error wearing three labels, and it is the same error as F-1 before them.
 * Fixing the instance three times left the class. The class, stated once:
 *
 *   Every revenue line carries an explicit settlementState. Every bucket has an
 *   explicit membership predicate in code. A line with no settlement state, or
 *   that satisfies no predicate, is a build error — not a default.
 *
 * So revenue is no longer three scalars a caller sorts by eye. It is a list of
 * `RevenueLine`s, each declaring its bucket, its settlement state and its
 * reliability, and the calculator derives every bucket and every classification
 * from predicates written below. Two partitions are asserted, both exclusive
 * and total:
 *   by BUCKET         linehaul | passThrough | otherAccessorial  → sum to gross
 *   by CLASSIFICATION reliable | atRisk       | unconfirmed      → sum to gross
 *
 * ── What the number IS (3B-R3 N-1; R3-4) ────────────────────────────────────
 * `trueEstimatedNet_cents` is CONTRIBUTION AFTER TRIP CASH COSTS AND CONFIGURED
 * PER-MILE / PER-DAY RESERVES, BEFORE INCOME TAX AND BEFORE ALLOCATED FIXED
 * COSTS (truck note, trailer note, lease escrow, insurance, plates).
 * This is NOT take-home, NOT weekly profit, NOT after-tax.
 * "Keep" can mean five different dollars; this module means exactly this one,
 * and every result says so in `assumptions.netDefinition`. A true number with
 * the wrong label is a confident lie.
 *
 * ── Integer cents, everywhere ────────────────────────────────────────────────
 * No floats touch the money path. Floats accumulate representation error across
 * the arithmetic steps below, so two loads with identical inputs could differ
 * by a cent depending on operation order — which makes "20 golden loads to the
 * cent" unachievable and a stored verdict non-reproducible.
 *
 * Quantities that are genuinely fractional are carried as scaled integers so
 * that the division happens exactly once, at the end, under `divRound`:
 *   - fuel economy  → `_milli` mpg    (6.5 mpg = 6500)
 *   - gallons       → `_milli` gal    (2.75 gal = 2750)
 *   - hours         → `_milli` hours  (1.5 h = 1500)
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
/**
 * 3B.3.0 — 3B-R3 (Grok pass N-1/N-2/N-3/N-5 + the F-2 amendment). Two changes
 * can move a figure or a verdict: `settlementMode: "self_dispatch"` zeroes the
 * dispatch haircut, and an optional carrier `hourlyFloor_cents` may turn a
 * verdict to skip. `dieselPriceSnapshotId` is now stamped on every result so
 * the fuel input that fed a stored verdict is pinned alongside the formula
 * version.
 */
/**
 * 3B.4.0 — SPEC-3B Revision 3 (ticket 3B-R4). Both the INPUT and the RESULT
 * shape changed, and real figures move on real loads. A 3B.3.0 result and a
 * 3B.4.0 result are not comparable and must never be mixed silently in the
 * ledger.
 *
 *   R3-1/2/3  revenue is `revenueLines[]`, each carrying settlementState +
 *             reliability; the three scalar revenue INPUTS are gone.
 *   R3-2      lumper reimbursement (reliability "claim") LEAVES reliable
 *             revenue — the headline number drops on loads that carry one.
 *             That is intended and ruled, not a regression.
 *   R3-4      `allCosts_cents` is the full thirteen-line sum and replaces the
 *             name `trueTripCost_cents`; DEF, idle fuel, lumper-as-a-cost,
 *             scale/permit cash, weight-distance/IFTA and factoring are new
 *             cost lines, so every net on a load carrying any of them drops.
 *             `knownExpenses_cents` is RENAMED `scalePermitOtherCash_cents`.
 *   R3-5      a fuel discount that meets or exceeds the posted price throws.
 *   R3-6      overhead is floored at a configurable minimum of one half-day,
 *             so short trips now carry more overhead than elapsed time alone.
 *   R3-8      `overhead_cents_per_day` joins MUST_BE_POSITIVE — a load that
 *             used to price with a silent zero-cost truck now returns
 *             NEEDS_INPUT.
 *   R3-9      detention exposure is reported as two separately labelled lines,
 *             both excluded from the net and the verdict.
 */
export const CALC_VERSION = "3B.4.0";

export type Verdict = "take" | "negotiate" | "skip";

/* ── revenue lines: the Rev 3 class fix ────────────────────────────────────── */

/**
 * R3-1. Where a revenue line stands between "somebody said so" and "the money
 * is in the account". Required on EVERY line; absent is NEEDS_INPUT naming the
 * line, never a default.
 *
 *   unconfirmed — the line exists on the load but no figure has been agreed.
 *                 The canonical case is an index fuel surcharge quoted "TBD at
 *                 invoice". Rev 2 dropped these out of ALL THREE buckets
 *                 including gross (F-5), which is why a "does gross look
 *                 healthy?" sanity check was blind to the ordinary case.
 *                 Rev 3: unconfirmed lines DO count in `grossRevenue_cents` and
 *                 DO display. They never enter `reliableRevenue_cents`, never
 *                 enter `atRiskAccessorialRevenue_cents`, and every one of them
 *                 raises a missing fact naming the line.
 *   confirmed   — agreed on paper: a rate-con figure or a contract formula.
 *   collected   — the money actually arrived. Set by 6E and only ever READ
 *                 here; the calculator never writes it. It exists because Rev 2
 *                 had no way OUT of at-risk — money that had genuinely landed
 *                 stayed excluded forever, so every recalculation after payday
 *                 understated the driver's net.
 */
export type SettlementState = "unconfirmed" | "confirmed" | "collected";
const SETTLEMENT_STATES: readonly SettlementState[] = ["unconfirmed", "confirmed", "collected"];

/**
 * R3-2. Reliability is a property OF THE LINE, declared by the caller — never
 * inferred from whichever bucket the line happens to sit in.
 *
 * Rev 2 used the bucket as a proxy: pass-through is reliable, other-accessorial
 * is at-risk. F-4 is what that proxy cost — a confirmed lumper REIMBURSEMENT
 * sits in pass-through and was therefore banked as reliable while being exactly
 * as unsettled as the detention removed one revision earlier. Brokers bounce
 * lumper receipts, cap them, and pay on their own schedule.
 *
 *   formula — the amount follows a stated contractual formula and arrives with
 *             the linehaul. A fuel surcharge on contract freight qualifies.
 *   claim   — the amount depends on someone else honouring a receipt, a
 *             timestamp, or a dispute. LUMPER REIMBURSEMENT, DETENTION, TONU,
 *             LAYOVER and STOP PAY all qualify, and none of them are reliable.
 */
export type Reliability = "formula" | "claim";
const RELIABILITIES: readonly Reliability[] = ["formula", "claim"];

/**
 * R3-3. The three buckets, and the only three. "Reimbursables" is WITHDRAWN as
 * a category name: a reimbursement is a pass-through line with
 * `reliability: "claim"`, which places it correctly without a third bucket.
 *
 * Rev 1 wrote the rule — "any future addition must state which of the three
 * buckets it belongs to, and it must belong to exactly one" — and Rev 2 broke
 * it by adding the phrase "confirmed reimbursables", a third name with no
 * membership test. Extra-stop pay, scale and permit reimbursement, tarp and
 * washout can each be coded either way; as pass-through they inflate the
 * headline and can flip the verdict, as other-accessorial they are excluded
 * from it, and in both they double-count.
 */
export type RevenueBucket = "linehaul" | "passThrough" | "otherAccessorial";
const REVENUE_BUCKETS: readonly RevenueBucket[] = ["linehaul", "passThrough", "otherAccessorial"];

/**
 * One line of revenue on the load. Every field is required; none is defaulted.
 *
 * `id` is a stable, caller-chosen name — "linehaul", "fuelSurcharge",
 * "lumperReimbursement", "detention", "stopPay2". It is opaque to the
 * calculator and is never parsed, but it IS the name the driver is shown when
 * the line is unconfirmed or when one of its fields is missing, so it should
 * read like something a human would recognise on a rate con.
 */
export interface RevenueLine {
  readonly id: string;
  readonly bucket: RevenueBucket;
  readonly amount_cents: number;
  readonly settlementState: SettlementState;
  readonly reliability: Reliability;
}

/** What a line counts as once the membership predicates below have run. */
export type RevenueClassification = "reliable" | "atRisk" | "unconfirmed";

/* ── the other declared enums ──────────────────────────────────────────────── */

/**
 * 3B-R3 (N-3): who takes the dispatch cut, if anyone.
 *   self_dispatch     — the driver books their own freight. The haircut is ZERO,
 *                       not a default percent: deducting a fee the driver does
 *                       not pay makes the app SKIP good freight.
 *   third_party       — an outside dispatch service; `brokerOrDispatchHaircut_bp`
 *                       applies to linehaul only (decision 4).
 *   in_house_percent  — a salaried/percent in-house dispatcher; same arithmetic
 *                       as third_party, kept distinct so the ledger can tell
 *                       them apart.
 */
export type SettlementMode = "self_dispatch" | "third_party" | "in_house_percent";
const SETTLEMENT_MODES: readonly SettlementMode[] = [
  "self_dispatch",
  "third_party",
  "in_house_percent",
];

/**
 * R3-7. What the factoring / QuickPay percentage is taken OF.
 *
 * Rev 2 banned factoring from the revenue base — correctly, it is not revenue —
 * and then never added it to costs, so "what I actually keep on Friday" was
 * modelled nowhere. It is a real settlement cost and it belongs in `allCosts`.
 *
 * Whether the fee applies to gross or to (rate − dispatch) DIFFERS BY CONTRACT
 * and both exist in the wild, so this is a per-carrier configured enum and never
 * an inferred default — the same fee-base discipline decisions 2 and 4 already
 * apply to driver pay and the dispatch haircut.
 *
 *   none                   — the carrier does not factor. The fee is ZERO and
 *                            any configured bp is ignored and echoed.
 *   gross                  — a percentage of the whole invoice.
 *   linehaul_less_dispatch — a percentage of linehaul after the dispatch
 *                            haircut.
 *
 * NOT RULED, and deliberately not invented here (R3-7, Grok's N-6): whether the
 * verdict should reflect CASH TIMING. The same load is worth factoring at 3% to
 * a driver three days from a truck payment and is a gift to the factor for one
 * sitting on 21 days of receivables. That needs a cash-need input the product
 * does not have. TODO(R3-7/N-6): stays open; do not model it here.
 */
export type FactoringBase = "none" | "gross" | "linehaul_less_dispatch";
const FACTORING_BASES: readonly FactoringBase[] = ["none", "gross", "linehaul_less_dispatch"];

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

/* ── input ─────────────────────────────────────────────────────────────────── */

/**
 * Every input the calculator reads. All money is integer cents; all percentages
 * are integer basis points; all distances are whole miles.
 */
export interface TrueNetInput {
  /**
   * R3-1/2/3: every dollar of revenue on this load, as declared lines. Required
   * and non-empty. The three scalar revenue inputs Rev 2 used are GONE — they
   * were the thing that let a line be sorted by eye into a bucket which then
   * carried an unstated reliability claim with it.
   *
   * Ids must be unique. A line missing `bucket`, `settlementState`,
   * `reliability` or `amount_cents` comes back as NEEDS_INPUT naming that line.
   */
  readonly revenueLines: readonly RevenueLine[];

  readonly loadedMiles: number;
  readonly deadheadMiles: number;
  readonly repositionMiles: number;

  /** Fuel economy in thousandths of a mile per gallon. 6.5 mpg = 6500. Must be > 0. */
  readonly mpgLoaded_milli: number;
  readonly mpgEmpty_milli: number;

  /** Posted pump price, integer cents per gallon. */
  readonly regionalDieselPrice_cents_per_gal: number;
  /**
   * 3B-R3 (N-5): an OPAQUE id for the price observation that produced
   * `regionalDieselPrice_cents_per_gal` (e.g. a fuel-feed row id, or a
   * "manual:<user>:<date>" tag). `CALC_VERSION` pins the formula; this pins
   * the fuel input, so a stored verdict can be re-derived the first time a
   * driver argues. Never parsed, never defaulted, stamped on every result.
   */
  readonly dieselPriceSnapshotId: string;
  /**
   * SPEC-3B decision 1: DOLLARS OFF PER GALLON, expressed in cents off per
   * gallon — not a percentage. Fuel-card programs quote dollars off posted pump
   * price, and this matches the Settings field already shipped.
   *
   * R3-5: if this MEETS OR EXCEEDS the posted price the calculator throws. Do
   * not sell infinite MPG.
   */
  readonly fuelDiscount_cents_per_gal: number;

  /**
   * R3-4, cost line 2. DEF for this trip, integer cents. A configured ZERO is a
   * valid, confirmed answer and means one of two things — a pre-emissions unit
   * with no DEF system, or a carrier who folds DEF into the fuel price.
   * `assumptions.defBasis` states which reading applies, so the zero is never
   * mistaken for a blank.
   */
  readonly def_cents: number;
  /**
   * R3-4, cost line 3. Dock and wait gallons, in THOUSANDTHS of a gallon — the
   * fuel burned sitting still, which `miles / mpg` cannot see because the truck
   * is not turning miles. Priced at the same effective (card-discounted) price
   * as road fuel. A confirmed zero is valid.
   */
  readonly idleFuelGallons_milli: number;
  /** R3-4, cost line 4. 0 is permitted ONLY as a confirmed zero — an absent field is NEEDS_INPUT. */
  readonly tolls_cents: number;
  /**
   * R3-4, cost line 5. CASH OUT AT THE DOCK, independent of any lumper
   * REIMBURSEMENT revenue line. Rev 2 modelled only the reimbursement side — a
   * one-directional error that always flatters the net, because the driver pays
   * the lumper whether or not anyone ever pays them back.
   */
  readonly lumperCost_cents: number;
  /**
   * R3-4, cost line 6. Scale tickets, permits and any other confirmed trip cash
   * with no named line of its own.
   *
   * RENAMED in 3B.4.0 from `knownExpenses_cents`. The rename is the point: two
   * fields that both mean "other cash the driver spent" is the F-6 unbounded-
   * alias error moved onto the cost side, so there is exactly one and the spec
   * names it.
   */
  readonly scalePermitOtherCash_cents: number;
  readonly maintenanceReserve_cents_per_mile: number;
  readonly tireReserve_cents_per_mile: number;
  /** R3-4, cost line 10. Weight-distance taxes and IFTA. Route-dependent; 0 only where the route has none. */
  readonly weightDistanceAndIfta_cents: number;

  /** Whole minutes. Integer by construction, so overhead needs no fractional-hour math. */
  readonly tripMinutes: number;
  /**
   * The carrier's own daily operating overhead, integer cents.
   *
   * R3-8: this is in MUST_BE_POSITIVE. A driver who set MPG and skipped
   * overhead used to pass every NEEDS_INPUT check and get a silent zero-cost
   * truck — a fully "valid" calculation of a fantasy. Zero is a missing fact
   * here, not a value.
   *
   * R3-4: this figure must EXCLUDE the truck note, trailer note, lease escrow
   * and insurance. Those are allocated fixed costs and `trueEstimatedNet_cents`
   * is contribution BEFORE them; folding them in silently turns the number into
   * something else. `assumptions.overheadInclusionBasis` repeats that back.
   */
  readonly overhead_cents_per_day: number;
  /**
   * R3-6. The overhead allocation floor, in whole minutes. Optional; when
   * absent it is ONE HALF-DAY (720 minutes) and `assumptions.overheadBasis`
   * says so either way.
   *
   * Pure elapsed-time allocation makes a two-hour yard move look nearly free,
   * which is false — a day on which one short move happens is still mostly
   * consumed. The floor is a STATED, OVERRIDABLE assumption that appears in
   * `assumptions[]`, never a hidden constant.
   */
  readonly overheadFloorMinutes?: number;

  readonly driverPay: DriverPay;
  /**
   * SPEC-3B decision 4: applied to LINEHAUL ONLY. Lumper and fuel surcharge are
   * not commissionable absent an explicit agreement. 3B-R3 (N-3): ignored —
   * forced to zero — when `settlementMode` is `self_dispatch`.
   */
  readonly brokerOrDispatchHaircut_bp: number;
  /** 3B-R3 (N-3). Required; see `SettlementMode`. Absent → NEEDS_INPUT, never assumed. */
  readonly settlementMode: SettlementMode;
  /** R3-7. Required; see `FactoringBase`. Absent → NEEDS_INPUT, never assumed. */
  readonly factoringBase: FactoringBase;
  /** R3-7. Ignored (and echoed in the assumptions) when `factoringBase` is `none`. */
  readonly factoringOrQuickPay_bp: number;

  /**
   * SPEC-3B decision 5: the carrier's OWN break-even and target, derived from
   * their Settings cost numbers. Never a global app-wide dollar threshold — a
   * fixed "counter for $300 more" was explicitly rejected in the Gill22 research
   * and would be wrong for every driver but one.
   */
  readonly breakEven_cents_per_mile: number;
  readonly target_cents_per_mile: number;

  /**
   * Whether detention TERMS are known for this load.
   *
   * SPEC-3B decision 3: when this is false or absent, detention contributes
   * EXACTLY 0 cents to the net — no weighting, no expected value, no
   * "conservative" fraction. Confirmed detention from a rate con is real revenue
   * and belongs in a `revenueLines` entry like any other accessorial (bucket
   * `otherAccessorial`, reliability `claim`); the ban is on ESTIMATING, not on
   * counting confirmed.
   */
  readonly detentionTermsKnown?: boolean;
  /**
   * R3-9. Detention HOURS on this load, in thousandths of an hour. Optional and
   * never defaulted: absent means the two exposure outputs are NEEDS_INPUT and
   * NO DOLLAR is shown. A configured zero is a real answer (no detention) and
   * produces zeroes.
   */
  readonly detentionHours_milli?: number;
  /**
   * R3-9. The rate the carrier expects to COLLECT for detention, integer cents
   * per hour, from Settings. Used only for the counterfactual line, which is
   * excluded from the net and from the verdict.
   */
  readonly detentionCollectRate_cents_per_hour?: number;

  /**
   * Rev 2 (F-2): how much of the driver's 11-hour drive clock this load
   * consumes, in WHOLE MINUTES (same integer convention as `tripMinutes`).
   * Optional and never defaulted: when absent, the two clock outputs report
   * NEEDS_INPUT and the verdict is unaffected. 3B does NOT price the clock —
   * inventing an hourly opportunity cost is the same class of error as
   * estimating detention. 3E decides its weight, against real data.
   */
  readonly clockMinutesConsumed?: number;

  /**
   * 3B-R3 (F-2 amendment): the CARRIER'S OWN hourly floor, integer cents per
   * available hour, from Settings. Rev 2 banned *the app* inventing an hourly
   * cost; it does not ban *the driver* stating one — that is the same class of
   * input as configured MPG or overhead/day (decision 5). When set AND the clock
   * is known, a load whose `netPerAvailableHour_cents` falls below it is SKIPPED.
   * When unset the gate does not run — no default, no guess. When set but the
   * clock is unknown, the gate cannot run and says so (risk flag + missing fact).
   */
  readonly hourlyFloor_cents?: number;
}

/* ── result ────────────────────────────────────────────────────────────────── */

/** One revenue line with the classification its predicate produced. Echoed on every result. */
export interface ClassifiedRevenueLine extends RevenueLine {
  readonly classification: RevenueClassification;
}

export interface TrueNetOk {
  readonly status: "OK";
  readonly calcVersion: string;
  /** 3B-R3 (N-5): the fuel-price observation this result was computed from. Pinned next to calcVersion. */
  readonly dieselPriceSnapshotId: string;
  /** The full input set, echoed so the result can be re-derived independently. */
  readonly input: TrueNetInput;

  /** R3-3: every line with the classification its predicate gave it. The audit trail for the headline. */
  readonly classifiedRevenueLines: readonly ClassifiedRevenueLine[];

  /* Partition 1 — by BUCKET. These three sum to grossRevenue_cents. */
  readonly linehaulRevenue_cents: number;
  readonly passThroughRevenue_cents: number;
  readonly otherAccessorialRevenue_cents: number;
  /** Still the correct all-in total; 6E reconciles booked-vs-paid against it. NOT the verdict's basis. */
  readonly grossRevenue_cents: number;

  /* Partition 2 — by CLASSIFICATION. These three also sum to grossRevenue_cents. */
  /**
   * R3-2: linehaul plus pass-through lines whose reliability is "formula", and
   * only where the line is settled. The net and the verdict see ONLY this figure.
   */
  readonly reliableRevenue_cents: number;
  /**
   * R3-2: every other confirmed-or-collected line — detention, stop pay,
   * layover, TONU, AND (new in Rev 3) lumper reimbursement. Confirmed on paper,
   * routinely denied or disputed after the fact. Reported separately, always
   * labelled, never in the net or the verdict.
   */
  readonly atRiskAccessorialRevenue_cents: number;
  /**
   * R3-1 (F-5): lines that exist on the load with no agreed figure. In gross,
   * displayed, and in NEITHER of the other two. Each one also raises a missing
   * fact naming the line.
   */
  readonly unconfirmedRevenue_cents: number;
  /** Display-only. Net plus at-risk. Unconfirmed dollars are NOT in here — there is no agreed figure to add. */
  readonly upsideIfAllAccessorialsPay_cents: number;

  readonly loadedMiles: number;
  readonly emptyMiles: number;
  readonly totalMiles: number;

  readonly effectiveDieselPrice_cents_per_gal: number;

  /* R3-4 — the thirteen cost lines, each named, each an integer number of cents. */
  readonly fuelCost_cents: number;
  readonly def_cents: number;
  readonly idleFuelCost_cents: number;
  readonly tolls_cents: number;
  readonly lumperCost_cents: number;
  readonly scalePermitOtherCash_cents: number;
  readonly maintenanceReserve_cents: number;
  readonly tireReserve_cents: number;
  readonly overhead_cents: number;
  readonly weightDistanceAndIfta_cents: number;
  readonly factoringOrQuickPay_cents: number;
  readonly driverPay_cents: number;
  readonly brokerOrDispatchHaircut_cents: number;
  /**
   * R3-4: the sum of the thirteen lines above and nothing else.
   *
   * RENAMED in 3B.4.0 from `trueTripCost_cents` to the name the spec uses, so
   * `trueEstimatedNet = reliableRevenue - allCosts` reads the same in the spec
   * and in the code.
   */
  readonly allCosts_cents: number;
  /**
   * R3-4 / 3B-R3 (N-1): contribution after trip cash costs and configured
   * per-mile / per-day reserves, BEFORE income tax and BEFORE allocated fixed
   * costs (truck note, trailer note, lease escrow, insurance, plates). This is
   * NOT take-home, NOT weekly profit, NOT after-tax. Built from RELIABLE
   * revenue only.
   */
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

  /**
   * R3-9, two separately labelled lines. BOTH ARE EXCLUDED FROM THE NET AND THE
   * VERDICT, and both are NEEDS_INPUT — no dollar at all — when the hours are
   * unknown.
   *
   * `waitCost_cents` is idle fuel plus the overhead allocated to the detention
   * minutes. It is a LABELLED VIEW of money already inside `allCosts_cents`,
   * not an extra deduction: it names what the waiting cost without charging it
   * twice.
   *
   * `counterfactualDetention_cents` is hours × the carrier's own configured
   * collect rate — what the wait WOULD have been worth had a detention term
   * existed. It is not revenue, it does not enter gross, and no probability is
   * invented anywhere.
   */
  readonly waitCost_cents: number | "NEEDS_INPUT";
  readonly counterfactualDetention_cents: number | "NEEDS_INPUT";

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

/** R3-6: minutes in a day, and the default overhead allocation floor (one half-day). */
const MINUTES_PER_DAY = 1440;
const DEFAULT_OVERHEAD_FLOOR_MINUTES = 720;

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

/* ── R3-3: membership predicates ───────────────────────────────────────────── */

/**
 * A line is SETTLED when a figure has been agreed or the money has arrived.
 * Unsettled means unconfirmed, and unconfirmed never reaches a headline figure.
 */
function isSettled(line: RevenueLine): boolean {
  return line.settlementState === "confirmed" || line.settlementState === "collected";
}

/**
 * R3-2's formula, as a predicate rather than a proxy: reliable revenue is
 * linehaul plus pass-through lines whose reliability is "formula" — and only
 * where the line is settled, because R3-1 keeps unconfirmed dollars out of every
 * headline.
 *
 * Note this is applied UNIFORMLY, including to linehaul. A linehaul line a
 * caller declares `unconfirmed` or `claim` is excluded, which is the whole point
 * of the class fix: no line is reliable by virtue of which bucket it landed in.
 */
function isReliableLine(line: RevenueLine): boolean {
  return (
    isSettled(line) &&
    line.reliability === "formula" &&
    (line.bucket === "linehaul" || line.bucket === "passThrough")
  );
}

/** R3-2: every other confirmed-or-collected line. Lumper reimbursement lands here. */
function isAtRiskLine(line: RevenueLine): boolean {
  return isSettled(line) && !isReliableLine(line);
}

/** R3-1 (F-5): in gross, displayed, in neither of the other two. */
function isUnconfirmedLine(line: RevenueLine): boolean {
  return line.settlementState === "unconfirmed";
}

/**
 * R3-3, enforced rather than asserted in prose: a line that satisfies no
 * predicate, or more than one, is a build error.
 *
 * With the enums above this cannot happen today — which is exactly why the check
 * is cheap and why it stays. What it guards is a FUTURE settlement state,
 * bucket or reliability added to a union without a predicate being updated to
 * match. That is the shape of every one of F-1, F-4, F-5 and F-6, and none of
 * them announced themselves; each showed up as a dollar quietly landing in the
 * wrong place.
 */
function classifyLine(line: RevenueLine): RevenueClassification {
  const matches: RevenueClassification[] = [];
  if (isReliableLine(line)) matches.push("reliable");
  if (isAtRiskLine(line)) matches.push("atRisk");
  if (isUnconfirmedLine(line)) matches.push("unconfirmed");
  if (matches.length !== 1) {
    throw new TrueNetError(
      `revenue line "${line.id}" satisfies ${matches.length} classification predicates, not exactly one ` +
        `(bucket=${String(line.bucket)}, settlementState=${String(line.settlementState)}, ` +
        `reliability=${String(line.reliability)}) — R3-3`,
    );
  }
  return matches[0]!;
}

/** R3-3: the bucket partition, checked for the same reason `classifyLine` is. */
function assertExactlyOneBucket(line: RevenueLine): void {
  const matches = REVENUE_BUCKETS.filter((b) => line.bucket === b);
  if (matches.length !== 1) {
    throw new TrueNetError(
      `revenue line "${line.id}" belongs to ${matches.length} buckets, not exactly one — R3-3`,
    );
  }
}

/* ── validation ────────────────────────────────────────────────────────────── */

const REQUIRED_INTEGER_FIELDS = [
  "loadedMiles",
  "deadheadMiles",
  "repositionMiles",
  "mpgLoaded_milli",
  "mpgEmpty_milli",
  "regionalDieselPrice_cents_per_gal",
  "fuelDiscount_cents_per_gal",
  "def_cents",
  "idleFuelGallons_milli",
  "tolls_cents",
  "lumperCost_cents",
  "scalePermitOtherCash_cents",
  "maintenanceReserve_cents_per_mile",
  "tireReserve_cents_per_mile",
  "weightDistanceAndIfta_cents",
  "tripMinutes",
  "overhead_cents_per_day",
  "brokerOrDispatchHaircut_bp",
  "factoringOrQuickPay_bp",
  "breakEven_cents_per_mile",
  "target_cents_per_mile",
] as const;

/**
 * R3-8: fields where a ZERO is a missing fact rather than a valid value.
 *
 * "Partial configuration is worse than no configuration" — a driver who set MPG
 * but skipped overhead used to pass every NEEDS_INPUT check and get a silent
 * zero-cost truck, which is a fully "valid" calculation of a fantasy.
 *
 * `overhead_cents_per_day` is NEW to this set in 3B.4.0, and is the reason the
 * T9 companion case exists: MPG present, overhead absent must return
 * NEEDS_INPUT naming overhead, never 0.
 *
 * Everything NOT in this set accepts a configured zero, because a zero is a real
 * answer there — tolls on a route with none, a driver-pay line where the owner
 * drives his own truck, DEF on a pre-emissions unit, IFTA on an intrastate run.
 */
const MUST_BE_POSITIVE = new Set<string>([
  "mpgLoaded_milli",
  "mpgEmpty_milli",
  "regionalDieselPrice_cents_per_gal",
  "tripMinutes",
  "overhead_cents_per_day",
  "breakEven_cents_per_mile",
  "target_cents_per_mile",
]);

/**
 * R3-1: validate the revenue lines and report what is absent BY LINE NAME.
 *
 * Structural problems (no id, a duplicate id, an enum value outside its union)
 * are a broken caller and THROW. Absent facts come back as NEEDS_INPUT naming
 * the line, because that is a question for a human.
 */
function collectMissingRevenueLines(lines: unknown, missing: string[]): void {
  if (lines === undefined || lines === null) {
    missing.push("revenueLines");
    return;
  }
  if (!Array.isArray(lines)) {
    throw new TrueNetError("revenueLines must be an array of revenue lines");
  }
  if (lines.length === 0) {
    // A load with no revenue lines at all is not a zero-revenue load; it is a
    // load nobody has entered yet. Fail closed and ask.
    missing.push("revenueLines");
    return;
  }

  const seen = new Set<string>();
  lines.forEach((raw: Partial<RevenueLine>, index: number) => {
    const id = raw?.id;
    if (typeof id !== "string" || id === "") {
      throw new TrueNetError(
        `revenueLines[${index}].id is required and must be a non-empty string`,
      );
    }
    if (seen.has(id)) {
      throw new TrueNetError(`revenueLines contains a duplicate id "${id}" — ids must be unique`);
    }
    seen.add(id);

    const amount = raw.amount_cents;
    if (amount === undefined || amount === null) {
      missing.push(`revenueLines[${id}].amount_cents`);
    } else if (!Number.isFinite(amount)) {
      throw new TrueNetError(`revenueLines[${id}].amount_cents is not finite`);
    } else if (!Number.isInteger(amount)) {
      throw new TrueNetError(
        `revenueLines[${id}].amount_cents must be an integer (got ${String(amount)})`,
      );
    } else if (amount < 0) {
      throw new TrueNetError(
        `revenueLines[${id}].amount_cents must not be negative (got ${String(amount)})`,
      );
    }

    const bucket = raw.bucket;
    if (bucket === undefined || bucket === null) {
      missing.push(`revenueLines[${id}].bucket`);
    } else if (!REVENUE_BUCKETS.includes(bucket)) {
      throw new TrueNetError(
        `revenueLines[${id}].bucket must be one of ${REVENUE_BUCKETS.join(" | ")} (got ${String(bucket)})`,
      );
    }

    // R3-1: the whole point of the revision. Absent is a question, not a default.
    const state = raw.settlementState;
    if (state === undefined || state === null) {
      missing.push(`revenueLines[${id}].settlementState`);
    } else if (!SETTLEMENT_STATES.includes(state)) {
      throw new TrueNetError(
        `revenueLines[${id}].settlementState must be one of ${SETTLEMENT_STATES.join(" | ")} (got ${String(state)})`,
      );
    }

    // R3-2: declared, never inferred from the bucket.
    const reliability = raw.reliability;
    if (reliability === undefined || reliability === null) {
      missing.push(`revenueLines[${id}].reliability`);
    } else if (!RELIABILITIES.includes(reliability)) {
      throw new TrueNetError(
        `revenueLines[${id}].reliability must be one of ${RELIABILITIES.join(" | ")} (got ${String(reliability)})`,
      );
    }
  });
}

function collectMissing(input: Partial<TrueNetInput>): string[] {
  const missing: string[] = [];

  collectMissingRevenueLines(input.revenueLines, missing);

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

  // 3B-R3 (N-3): the settlement mode is a fact about the carrier, never assumed.
  const mode = input.settlementMode;
  if (mode === undefined || mode === null) {
    missing.push("settlementMode");
  } else if (!SETTLEMENT_MODES.includes(mode)) {
    throw new TrueNetError(
      `settlementMode must be one of ${SETTLEMENT_MODES.join(" | ")} (got ${String(mode)})`,
    );
  }

  // R3-7: the factoring base differs by contract and both shapes exist in the wild.
  const factoringBase = input.factoringBase;
  if (factoringBase === undefined || factoringBase === null) {
    missing.push("factoringBase");
  } else if (!FACTORING_BASES.includes(factoringBase)) {
    throw new TrueNetError(
      `factoringBase must be one of ${FACTORING_BASES.join(" | ")} (got ${String(factoringBase)})`,
    );
  }

  // 3B-R3 (N-5): an unpinned fuel price is a missing fact — the verdict could not be re-derived.
  const snapshot = input.dieselPriceSnapshotId;
  if (snapshot === undefined || snapshot === null || snapshot === "") {
    missing.push("dieselPriceSnapshotId");
  } else if (typeof snapshot !== "string") {
    throw new TrueNetError("dieselPriceSnapshotId must be a string");
  }

  // R3-6: optional, but if the carrier overrides the floor it must be a real figure.
  const floorMinutes = input.overheadFloorMinutes;
  if (floorMinutes !== undefined) {
    if (!Number.isSafeInteger(floorMinutes) || floorMinutes < 0) {
      throw new TrueNetError(
        `overheadFloorMinutes must be a non-negative integer number of minutes (got ${String(floorMinutes)})`,
      );
    }
  }

  // R3-9: optional, but a supplied figure must be a real one.
  const detentionHours = input.detentionHours_milli;
  if (detentionHours !== undefined) {
    if (!Number.isSafeInteger(detentionHours) || detentionHours < 0) {
      throw new TrueNetError(
        `detentionHours_milli must be a non-negative integer number of thousandths of an hour (got ${String(detentionHours)})`,
      );
    }
  }
  const detentionRate = input.detentionCollectRate_cents_per_hour;
  if (detentionRate !== undefined) {
    if (!Number.isSafeInteger(detentionRate) || detentionRate < 0) {
      throw new TrueNetError(
        `detentionCollectRate_cents_per_hour must be a non-negative integer number of cents (got ${String(detentionRate)})`,
      );
    }
  }

  // 3B-R3 (F-2 amendment): optional, but if the carrier set one it must be a real figure.
  const floor = input.hourlyFloor_cents;
  if (floor !== undefined) {
    if (!Number.isSafeInteger(floor) || floor <= 0) {
      throw new TrueNetError(
        `hourlyFloor_cents must be a positive integer number of cents (got ${String(floor)})`,
      );
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
 * R3-5, now the spec rather than an implementation accident. Fuel for one leg,
 * in integer cents.
 *
 * gallons = miles / mpg, and mpg is carried in thousandths, so
 *   gallons = miles * 1000 / mpg_milli
 * and the cost is that times the effective price. Both are folded into a single
 * `divRound`, so EXACTLY ONE ROUNDING HAPPENS PER LEG and no float is formed at
 * any point. Loaded and empty legs are computed separately with their own MPG
 * and summed; neither leg's rounding feeds the other.
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

  /*
   * R3-1/2/3 — revenue, through the predicates. Two partitions are derived here
   * and both are total: by bucket (three figures that sum to gross) and by
   * classification (three figures that sum to gross). Nothing below this block
   * looks at a bucket to decide whether a dollar is reliable.
   */
  const classifiedRevenueLines: ClassifiedRevenueLine[] = i.revenueLines.map((line) => {
    assertExactlyOneBucket(line);
    return { ...line, classification: classifyLine(line) };
  });

  const sumWhere = (label: string, predicate: (l: ClassifiedRevenueLine) => boolean): number =>
    guard(
      label,
      classifiedRevenueLines.reduce(
        (total, l) => (predicate(l) ? total + l.amount_cents : total),
        0,
      ),
    );

  const linehaulRevenue_cents = sumWhere("linehaulRevenue_cents", (l) => l.bucket === "linehaul");
  const passThroughRevenue_cents = sumWhere(
    "passThroughRevenue_cents",
    (l) => l.bucket === "passThrough",
  );
  const otherAccessorialRevenue_cents = sumWhere(
    "otherAccessorialRevenue_cents",
    (l) => l.bucket === "otherAccessorial",
  );
  const grossRevenue_cents = sumWhere("grossRevenue_cents", () => true);

  const reliableRevenue_cents = sumWhere(
    "reliableRevenue_cents",
    (l) => l.classification === "reliable",
  );
  const atRiskAccessorialRevenue_cents = sumWhere(
    "atRiskAccessorialRevenue_cents",
    (l) => l.classification === "atRisk",
  );
  const unconfirmedRevenue_cents = sumWhere(
    "unconfirmedRevenue_cents",
    (l) => l.classification === "unconfirmed",
  );

  // Both partitions are total by construction. Checked anyway: a silently
  // non-exhaustive partition is precisely how F-5 shipped.
  if (
    linehaulRevenue_cents + passThroughRevenue_cents + otherAccessorialRevenue_cents !==
    grossRevenue_cents
  ) {
    throw new TrueNetError("the three revenue BUCKETS do not sum to grossRevenue_cents — R3-3");
  }
  if (
    reliableRevenue_cents + atRiskAccessorialRevenue_cents + unconfirmedRevenue_cents !==
    grossRevenue_cents
  ) {
    throw new TrueNetError(
      "the three revenue CLASSIFICATIONS do not sum to grossRevenue_cents — R3-3",
    );
  }

  /*
   * Distance. Deadhead and reposition are both run empty, so they share mpgEmpty.
   *
   * DEADHEAD ATTRIBUTION — 3B-R3 (N-2). Which empty miles belong to THIS load:
   *   - Inbound empty (to the shipper):        THIS load, always.
   *   - Outbound empty (after delivery):        THIS load, UNLESS a confirmed
   *     next load exists — then it attaches to the NEXT load, never to both.
   *   - Intentional repositioning empty:        NOT a trip cost of any load.
   * Charging an empty leg to both loads double-counts it and SKIPs a profitable
   * pair; charging it to neither TAKEs a desert drop. The caller assembles
   * `deadheadMiles` under this rule; the calculator does not know about the
   * next load and cannot check it.
   *
   * TODO(N-2, needs a Cowork ruling): `repositionMiles` is charged here at the
   * empty fuel rate plus per-mile reserves (golden G18), which contradicts the
   * third line above. SPEC-3B never mentions reposition miles at all. 3B-R3
   * asked for the rule as a COMMENT, not an arithmetic change, so the charge
   * stands until the spec says which it is. Callers who follow N-2 pass 0 here.
   */
  const emptyMiles = guard("emptyMiles", i.deadheadMiles + i.repositionMiles);
  const totalMiles = guard("totalMiles", i.loadedMiles + emptyMiles);
  if (totalMiles === 0) {
    throw new TrueNetError("totalMiles is zero — a load with no distance cannot be priced");
  }

  /*
   * Fuel. Decision 1: the discount is dollars (cents) off the posted price.
   *
   * R3-5: a discount that MEETS OR EXCEEDS the posted price throws. Rev 2 only
   * rejected a NEGATIVE effective price, which let a discount exactly equal to
   * the pump price produce free fuel and an infinitely profitable load. Do not
   * sell infinite MPG.
   */
  const effectiveDieselPrice_cents_per_gal = guard(
    "effectiveDieselPrice_cents_per_gal",
    i.regionalDieselPrice_cents_per_gal - i.fuelDiscount_cents_per_gal,
  );
  if (effectiveDieselPrice_cents_per_gal <= 0) {
    throw new TrueNetError(
      `fuel discount exceeds or equals the posted diesel price ` +
        `(${i.fuelDiscount_cents_per_gal}c off ${i.regionalDieselPrice_cents_per_gal}c) — ` +
        `do not sell infinite MPG (R3-5)`,
    );
  }
  const fuelCost_cents = guard(
    "fuelCost_cents",
    legFuelCost_cents(i.loadedMiles, i.mpgLoaded_milli, effectiveDieselPrice_cents_per_gal) +
      legFuelCost_cents(emptyMiles, i.mpgEmpty_milli, effectiveDieselPrice_cents_per_gal),
  );

  /*
   * R3-4, cost line 3. Idle fuel: gallons burned sitting still, which the
   * miles/mpg formula cannot see. Gallons are carried in thousandths so the
   * single rounding happens here and nowhere else.
   */
  const idleFuelCost_cents = guard(
    "idleFuelCost_cents",
    divRound(i.idleFuelGallons_milli * effectiveDieselPrice_cents_per_gal, 1000),
  );

  /* Per-mile reserves apply to every mile the truck turns, loaded or empty. */
  const maintenanceReserve_cents = guard(
    "maintenanceReserve_cents",
    i.maintenanceReserve_cents_per_mile * totalMiles,
  );
  const tireReserve_cents = guard("tireReserve_cents", i.tireReserve_cents_per_mile * totalMiles);

  /*
   * R3-6. Overhead is a daily figure prorated across ELAPSED TRIP TIME, floored
   * at a configurable minimum of one half-day.
   *
   * A two-hour hook is 2/24 of a day, 2/11 of an HOS day, or one calendar day —
   * three different verdicts, and Rev 2 picked none. Pure elapsed-time
   * allocation makes a two-hour yard move look nearly free, which is false: a
   * day on which one short move happens is still mostly consumed. The floor is
   * stated in `assumptions.overheadBasis` and is overridable per carrier, so it
   * is never a hidden constant.
   *
   * `netPerAvailableDay_cents` below deliberately uses ACTUAL `tripMinutes`, not
   * the floored figure — the floor is an allocation rule for a cost, not a claim
   * about how long the trip took.
   */
  const overheadFloorMinutes = i.overheadFloorMinutes ?? DEFAULT_OVERHEAD_FLOOR_MINUTES;
  const overheadMinutes = Math.max(i.tripMinutes, overheadFloorMinutes);
  const overhead_cents = guard(
    "overhead_cents",
    divRound(i.overhead_cents_per_day * overheadMinutes, MINUTES_PER_DAY),
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
      driverPayRaw = divRound(linehaulRevenue_cents * i.driverPay.percent_bp, 10_000);
      break;
    case "perMile":
      driverPayRaw = i.driverPay.rate_cents_per_mile * totalMiles;
      break;
  }
  const driverPay_cents = guard("driverPay_cents", driverPayRaw);

  /*
   * FEE ORDER OF OPERATIONS — 3B-R3 (N-3). There is no order. Every fee (driver
   * percentage above, dispatch haircut here, any future percentage line) is
   * computed INDEPENDENTLY from `linehaulRevenue_cents`. Fees are never stacked
   * — never "haircut off (linehaul minus driver pay)" or the reverse — so the
   * result cannot depend on which one is written first.
   *
   * Decision 4: the haircut is on LINEHAUL ONLY. F-3: independent multiply,
   * half-up. N-3: under `self_dispatch` the haircut is ZERO — the driver pays no
   * dispatch fee, and deducting one anyway would SKIP good freight. The
   * configured bp is echoed in `assumptions.haircutBasis` so an ignored setting
   * stays visible.
   */
  const haircutApplies = i.settlementMode !== "self_dispatch";
  const brokerOrDispatchHaircut_cents = guard(
    "brokerOrDispatchHaircut_cents",
    haircutApplies ? divRound(linehaulRevenue_cents * i.brokerOrDispatchHaircut_bp, 10_000) : 0,
  );

  /*
   * R3-4 cost line 11 / R3-7. Factoring or QuickPay.
   *
   * THE ONE DECLARED EXCEPTION TO F-3's "never chained" rule, and it is stated
   * here rather than slipped in: under `linehaul_less_dispatch` THE CONTRACT
   * ITSELF defines the fee base as the post-dispatch amount, so the base is
   * (linehaul − haircut), which is one already-rounded figure. Computing the fee
   * off an unrounded base would charge it on money that does not exist. Exactly
   * one further rounding happens, here. Under `gross` and `none` nothing is
   * chained at all.
   *
   * `gross` includes unconfirmed lines, because what gets factored is the
   * INVOICE and an unconfirmed fuel surcharge is invoiced. That direction is the
   * conservative one — it raises a cost without raising reliable revenue.
   */
  let factoringBase_cents: number;
  switch (i.factoringBase) {
    case "none":
      factoringBase_cents = 0;
      break;
    case "gross":
      factoringBase_cents = grossRevenue_cents;
      break;
    case "linehaul_less_dispatch":
      factoringBase_cents = linehaulRevenue_cents - brokerOrDispatchHaircut_cents;
      break;
  }
  if (factoringBase_cents < 0) {
    throw new TrueNetError(
      "factoring base is negative — the dispatch haircut exceeds linehaul revenue, which is not a real contract",
    );
  }
  const factoringOrQuickPay_cents = guard(
    "factoringOrQuickPay_cents",
    i.factoringBase === "none"
      ? 0
      : divRound(factoringBase_cents * i.factoringOrQuickPay_bp, 10_000),
  );

  /*
   * R3-4. `allCosts_cents` — the sum Rev 2 named and never wrote. Thirteen named
   * lines, in the spec's order, and nothing else.
   *
   * NOT IN HERE, DELIBERATELY: the truck note, trailer note, lease escrow and
   * insurance. Those are ALLOCATED FIXED COSTS and `trueEstimatedNet_cents` is
   * defined as contribution BEFORE them (N-1). If a carrier's configured
   * `overhead_cents_per_day` already contains the note, this number silently
   * becomes something else — which is why `assumptions.overheadInclusionBasis`
   * repeats back what overhead/day is meant to include.
   *
   * TODO(N-4, owed by Cowork): the fixed-cost allocation policy and the weekly
   * coverage gate. Not invented here.
   */
  const allCosts_cents = guard(
    "allCosts_cents",
    fuelCost_cents +
      i.def_cents +
      idleFuelCost_cents +
      i.tolls_cents +
      i.lumperCost_cents +
      i.scalePermitOtherCash_cents +
      maintenanceReserve_cents +
      tireReserve_cents +
      overhead_cents +
      i.weightDistanceAndIfta_cents +
      factoringOrQuickPay_cents +
      driverPay_cents +
      brokerOrDispatchHaircut_cents,
  );

  /*
   * Rev 2 (F-1) as amended by R3-1/R3-2: "confirmed" is not "paid", and which
   * bucket a line sits in does not decide whether it is reliable. The net a
   * driver acts on is built from RELIABLE revenue only — settled lines that
   * follow a contractual formula. At-risk dollars (detention, stop pay, layover,
   * TONU and now lumper reimbursement) and unconfirmed dollars are reported
   * separately and never summed into the headline. `grossRevenue_cents` stays
   * the true all-in total for 6E's booked-vs-paid reconciliation.
   */
  const trueEstimatedNet_cents = guard(
    "trueEstimatedNet_cents",
    reliableRevenue_cents - allCosts_cents,
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
    divRound(trueEstimatedNet_cents * MINUTES_PER_DAY, i.tripMinutes),
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

  const riskFlags: string[] = [];
  const missingFacts: string[] = [];

  /*
   * R3-9 — CONFLICT-1, closed AGAINST Cowork's own earlier position.
   *
   * The rejected proposal was to show what the wait would cost at the driver's
   * configured detention rate. That required a dollar; a dollar required hours;
   * and the missing fact WAS the hours — so it reintroduced the estimate in a
   * yellow box. Worse, a detention RATE is revenue, and showing one anchors the
   * driver toward TAKE.
   *
   *   hours unknown → both outputs NEEDS_INPUT. NO DOLLAR. Decision 3 untouched.
   *   hours known   → two separately labelled lines, BOTH EXCLUDED FROM THE NET
   *                   and from the verdict.
   *
   * No probability is invented anywhere, in either branch.
   */
  const detentionHoursKnown = typeof i.detentionHours_milli === "number";
  let waitCost_cents: number | "NEEDS_INPUT";
  let counterfactualDetention_cents: number | "NEEDS_INPUT";
  if (!detentionHoursKnown) {
    waitCost_cents = "NEEDS_INPUT";
    counterfactualDetention_cents = "NEEDS_INPUT";
    missingFacts.push("detentionHours");
    riskFlags.push(
      "Detention hours unknown — the wait exposure cannot be shown as a dollar and was not estimated.",
    );
  } else {
    const hours_milli = i.detentionHours_milli as number;
    const detentionMinutes = divRound(hours_milli * 60, 1000);
    // Idle fuel IS the dock/wait fuel by definition, so all of it is wait cost;
    // the overhead share is the overhead allocated to the detention minutes.
    // Both are ALREADY inside allCosts_cents — this line NAMES what the wait
    // cost, it does not charge it a second time.
    waitCost_cents = guard(
      "waitCost_cents",
      idleFuelCost_cents + divRound(i.overhead_cents_per_day * detentionMinutes, MINUTES_PER_DAY),
    );
    if (typeof i.detentionCollectRate_cents_per_hour === "number") {
      counterfactualDetention_cents = guard(
        "counterfactualDetention_cents",
        divRound(hours_milli * i.detentionCollectRate_cents_per_hour, 1000),
      );
    } else {
      counterfactualDetention_cents = "NEEDS_INPUT";
      missingFacts.push("detentionCollectRate_cents_per_hour");
    }
  }

  /* Decision 3: detention is never estimated into the net. Flag it instead. */
  if (i.detentionTermsKnown !== true) {
    riskFlags.push("Detention terms/hours unknown — not included in estimated net.");
    missingFacts.push("detentionTermsKnown");
  }

  /*
   * R3-1 (F-5): every unconfirmed line raises a missing fact NAMING THE LINE.
   * This is what makes an unconfirmed fuel surcharge visible instead of silently
   * absent — the failure mode that made a "gross looks healthy" check blind to
   * the ordinary case.
   */
  for (const line of classifiedRevenueLines) {
    if (line.classification !== "unconfirmed") continue;
    missingFacts.push(line.id);
    riskFlags.push(
      `"${line.id}" is on the load with no agreed figure — its ${line.amount_cents}c is counted in gross but NOT in the estimated net.`,
    );
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
   * paid, so at-risk and unconfirmed dollars are structurally absent from every
   * comparison below: the net is reliable-minus-costs, and the threshold
   * comparisons use reliableRevenue_cents, never grossRevenue_cents.
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
    reasons.push(
      "Confirmed accessorials were not counted toward this verdict — they are at risk until paid.",
    );
  }
  if (unconfirmedRevenue_cents > 0) {
    reasons.push(
      "Unconfirmed revenue lines are shown in gross but were not counted toward this verdict.",
    );
  }

  /*
   * 3B-R3 (F-2 amendment): the carrier's OWN hourly floor may turn a verdict to
   * SKIP — never upgrade one. The app still does not price the clock; the driver
   * did, in Settings, and decision 5 already runs the verdict against the
   * carrier's own figures. Three states, none defaulted:
   *   floor unset            → gate does not run.
   *   floor set, clock known → skip when net per available hour is below it.
   *   floor set, clock unknown → gate cannot run; flagged and listed as missing,
   *                              because now the clock DOES bear on the verdict.
   */
  const floorSet = typeof i.hourlyFloor_cents === "number";
  let hourlyFloorBasis: string;
  if (!floorSet) {
    hourlyFloorBasis =
      "no hourly floor configured — the hourly gate did not run (3B-R3, F-2 amendment)";
  } else if (typeof netPerAvailableHour_cents !== "number") {
    hourlyFloorBasis = `hourly floor ${i.hourlyFloor_cents}c configured but clock minutes unknown — gate NOT evaluated (3B-R3, F-2 amendment)`;
    riskFlags.push(
      `Hourly floor of ${i.hourlyFloor_cents}c/hr is set but the clock minutes are unknown — the floor was not checked.`,
    );
    missingFacts.push("clockMinutesConsumed");
  } else if (netPerAvailableHour_cents < (i.hourlyFloor_cents as number)) {
    hourlyFloorBasis = `net per available hour ${netPerAvailableHour_cents}c is below your own floor of ${i.hourlyFloor_cents}c — verdict turned to skip (3B-R3, F-2 amendment)`;
    verdict = "skip";
    reasons.push(
      `Net per available hour (${netPerAvailableHour_cents}c) is below your own hourly floor (${i.hourlyFloor_cents}c).`,
    );
  } else {
    hourlyFloorBasis = `net per available hour ${netPerAvailableHour_cents}c clears your own floor of ${i.hourlyFloor_cents}c (3B-R3, F-2 amendment)`;
  }

  if (riskFlags.length > 0) {
    reasons.push("Unknown facts are excluded from the net rather than estimated.");
  }

  const describeLine = (l: ClassifiedRevenueLine): string =>
    `${l.id} ${l.amount_cents}c [${l.bucket}/${l.settlementState}/${l.reliability} → ${l.classification}]`;

  const assumptions: Record<string, string> = {
    calculatedFrom:
      `${totalMiles} total miles (${i.loadedMiles} loaded + ${emptyMiles} empty), ` +
      `fuel at ${effectiveDieselPrice_cents_per_gal}c/gal effective ` +
      `(${i.regionalDieselPrice_cents_per_gal}c posted less ${i.fuelDiscount_cents_per_gal}c card discount)`,
    revenueLineBasis: classifiedRevenueLines.map(describeLine).join(" ; "),
    bucketMembershipBasis:
      `linehaul ${linehaulRevenue_cents}c + pass-through ${passThroughRevenue_cents}c + ` +
      `other accessorial ${otherAccessorialRevenue_cents}c = gross ${grossRevenue_cents}c; ` +
      "every line declares exactly one bucket and 'reimbursables' is not a category (R3-3)",
    settlementStateBasis:
      `reliable ${reliableRevenue_cents}c + at-risk ${atRiskAccessorialRevenue_cents}c + ` +
      `unconfirmed ${unconfirmedRevenue_cents}c = gross ${grossRevenue_cents}c; unconfirmed lines ` +
      "count in gross and display, and never enter the net or the verdict (R3-1)",
    reliabilityBasis:
      "reliability is declared per line, never inferred from its bucket: 'formula' arrives with the " +
      "linehaul, 'claim' depends on someone honouring a receipt, a timestamp or a dispute. Lumper " +
      "reimbursement, detention, TONU, layover and stop pay are all claims and none are reliable (R3-2)",
    fuelDiscountBasis: "dollars off per gallon (SPEC-3B decision 1)",
    fuelFormulaBasis:
      "miles x 1000 x effective price / mpg_milli, one rounding per leg, loaded and empty computed separately (R3-5)",
    defBasis:
      i.def_cents > 0
        ? `${i.def_cents}c DEF charged as its own cost line (R3-4)`
        : "0c DEF — a confirmed zero, meaning no DEF system or DEF already folded into the fuel price, not a blank (R3-4)",
    idleFuelBasis:
      `${i.idleFuelGallons_milli} thousandths of a gallon burned at the dock, priced at the same ` +
      `${effectiveDieselPrice_cents_per_gal}c/gal effective rate — miles/mpg cannot see these gallons (R3-4)`,
    lumperBasis:
      `${i.lumperCost_cents}c paid out at the dock, charged independently of any lumper reimbursement ` +
      "revenue line; modelling only the reimbursement side always flatters the net (R3-4)",
    allCostsBasis:
      "fuel + DEF + idle fuel + tolls + lumper cash + scale/permit/other cash + maintenance reserve + " +
      "tire reserve + overhead + weight-distance/IFTA + factoring + driver pay + dispatch haircut (R3-4)",
    overheadBasis:
      `${i.overhead_cents_per_day}c/day allocated over ${overheadMinutes} minutes ` +
      `(trip ${i.tripMinutes} min, floored at ${overheadFloorMinutes} min` +
      `${i.overheadFloorMinutes === undefined ? ", the default half-day" : ", carrier override"}) ` +
      `/ ${MINUTES_PER_DAY} = ${overhead_cents}c (R3-6)`,
    overheadInclusionBasis:
      "overhead/day is your configured daily operating overhead EXCLUDING truck note, trailer note, " +
      "lease escrow and insurance — those are allocated fixed costs and this net is contribution " +
      "before them (R3-4, N-1)",
    factoringBasis:
      i.factoringBase === "none"
        ? `0 — no factoring configured; configured ${i.factoringOrQuickPay_bp}bp ignored (R3-7)`
        : `${i.factoringOrQuickPay_bp}bp of ${
            i.factoringBase === "gross" ? "gross revenue" : "linehaul less the dispatch haircut"
          } = ${factoringOrQuickPay_cents}c; the base is a per-carrier contract setting, never inferred (R3-7)`,
    driverPayBasis:
      i.driverPay.type === "percent"
        ? "percentage of linehaul revenue only (SPEC-3B decision 2)"
        : i.driverPay.type === "perMile"
          ? "per mile, all miles"
          : "no driver pay line",
    detentionBasis:
      i.detentionTermsKnown === true
        ? "confirmed detention counted as an otherAccessorial revenue line, classified at-risk until paid"
        : "0 cents — detention terms unknown and never estimated (SPEC-3B decision 3)",
    detentionExposureBasis: detentionHoursKnown
      ? `wait cost ${String(waitCost_cents)}c (idle fuel + overhead allocated to the detention minutes; ` +
        `already inside allCosts, named here rather than charged twice) and counterfactual detention ` +
        `${String(counterfactualDetention_cents)}c (hours x your configured collect rate) — BOTH excluded ` +
        `from the net and the verdict (R3-9)`
      : "detention hours unknown — both exposure lines are NEEDS_INPUT and NO dollar is shown; no probability invented (R3-9)",
    haircutBasis: haircutApplies
      ? `percentage of linehaul revenue only (SPEC-3B decision 4); settlement mode ${i.settlementMode}`
      : `0 — self-dispatch pays no dispatch fee; configured ${i.brokerOrDispatchHaircut_bp}bp ignored (3B-R3, N-3)`,
    feeOrderBasis:
      "each fee computed independently from linehaul; fees are never stacked on one another. The single " +
      "declared exception is factoring on a linehaul_less_dispatch base, where the contract itself " +
      "defines the base (3B-R3, N-3; Rev 2, F-3; R3-7)",
    deadheadBasis: `${i.deadheadMiles} deadhead + ${i.repositionMiles} reposition miles charged as supplied; inbound empty is this load's, outbound empty is this load's unless a confirmed next load exists (3B-R3, N-2)`,
    dieselPriceSnapshot: `regional diesel ${i.regionalDieselPrice_cents_per_gal}c/gal from snapshot ${i.dieselPriceSnapshotId} (3B-R3, N-5)`,
    netDefinition:
      "contribution after trip cash costs and configured per-mile / per-day reserves, before income tax and before allocated fixed costs (truck note, trailer note, lease escrow, insurance, plates). NOT take-home, NOT weekly profit, NOT after-tax (3B-R3, N-1; R3-4)",
    hourlyFloorBasis,
    netBasis:
      "reliable revenue (settled formula lines in linehaul and pass-through) less all costs; claims and unconfirmed lines are excluded until paid (SPEC-3B Rev 3, R3-1/R3-2)",
    atRiskBasis:
      atRiskAccessorialRevenue_cents > 0
        ? `${atRiskAccessorialRevenue_cents}c confirmed but unsettled — shown separately, never in the net or the verdict`
        : "no confirmed at-risk lines on this load",
    clockBasis: clockKnown
      ? "clock hours reported only — 3B does not price the driver's clock (SPEC-3B Rev 2, F-2)"
      : "clock hours unknown — reported as NEEDS_INPUT, never defaulted, not in the verdict (SPEC-3B Rev 2, F-2)",
    roundingBasis:
      "half-up, away from zero, on each percentage multiply, each computed independently from linehaul (SPEC-3B Rev 2, F-3)",
    verdictBasis:
      `your own break-even ${i.breakEven_cents_per_mile}c/mi and target ` +
      `${i.target_cents_per_mile}c/mi, not a global threshold (SPEC-3B decision 5); ` +
      "evaluated on reliable revenue and the reliable net only (Rev 2, F-1; Rev 3, R3-2)",
    confidence:
      missingFacts.length === 0
        ? "All inputs confirmed."
        : `Excludes ${missingFacts.length} unknown fact(s); the net is conservative by construction.`,
  };

  return {
    status: "OK",
    calcVersion: CALC_VERSION,
    dieselPriceSnapshotId: i.dieselPriceSnapshotId,
    input: i,
    classifiedRevenueLines,
    linehaulRevenue_cents,
    passThroughRevenue_cents,
    otherAccessorialRevenue_cents,
    grossRevenue_cents,
    reliableRevenue_cents,
    atRiskAccessorialRevenue_cents,
    unconfirmedRevenue_cents,
    upsideIfAllAccessorialsPay_cents,
    loadedMiles: i.loadedMiles,
    emptyMiles,
    totalMiles,
    effectiveDieselPrice_cents_per_gal,
    fuelCost_cents,
    def_cents: i.def_cents,
    idleFuelCost_cents,
    tolls_cents: i.tolls_cents,
    lumperCost_cents: i.lumperCost_cents,
    scalePermitOtherCash_cents: i.scalePermitOtherCash_cents,
    maintenanceReserve_cents,
    tireReserve_cents,
    overhead_cents,
    weightDistanceAndIfta_cents: i.weightDistanceAndIfta_cents,
    factoringOrQuickPay_cents,
    driverPay_cents,
    brokerOrDispatchHaircut_cents,
    allCosts_cents,
    trueEstimatedNet_cents,
    allInRpm_millicents_per_mile,
    netPerAvailableDay_cents,
    clockHoursConsumed_milli,
    netPerAvailableHour_cents,
    waitCost_cents,
    counterfactualDetention_cents,
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
 * - R3-7 CASH TIMING (Grok's N-6). The same load is worth factoring at 3% to a
 *   driver three days from a truck payment and is a gift to the factor for one
 *   sitting on 21 days of receivables. Needs a cash-need input the product does
 *   not have, and it touches what the product claims to tell a driver. The
 *   factoring COST line above is ruled and built; the timing question is not.
 * - R3-10 FEE BASE ON KILLED LOADS. Decisions 2 and 4 put driver pay and the
 *   dispatch haircut on linehaul only, but many dispatch agreements do take a
 *   percentage of TONU and many lease settlements include it, so on a killed
 *   load this model mis-states what the driver keeps. It is a contract-mode
 *   flag, not a formula change, and it needs one carrier's actual dispatch
 *   agreement to check against. Recorded, not ruled, not invented.
 * - N-4 fixed-cost allocation policy and the weekly coverage gate. Owed by
 *   Cowork.
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
