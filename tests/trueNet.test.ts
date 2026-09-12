import { describe, expect, it } from "vitest";

import {
  CALC_VERSION,
  TrueNetError,
  calculateTrueNet,
  type FactoringBase,
  type Reliability,
  type RevenueBucket,
  type RevenueLine,
  type SettlementState,
  type TrueNetInput,
  type TrueNetOk,
} from "../packages/domain/trueNet.ts";

/**
 * SPEC 3B gate: 20 golden loads to the cent, plus property tests.
 *
 * Every expected number below was derived by hand from the formulas in
 * SPEC-3B-TRUENET-CONTRACT.md and SPEC-3B-REV3-DELTA.md and is written as a
 * literal. None was copied out of a run — a golden case that records whatever
 * the code happened to print pins the bug rather than the contract. The
 * arithmetic is shown in the comment above each case so a reviewer can check it
 * without running anything.
 *
 * ── Rev 3 (3B-R4) note on the goldens ───────────────────────────────────────
 * Revenue is now `revenueLines[]` rather than three scalars. The `load()` helper
 * below rebuilds the SAME three amounts as three declared lines, so every figure
 * G01–G20 asserts is unchanged from Rev 2 except where a Rev 3 ruling moves it,
 * and each of those is called out in its own comment. The base pass-through is
 * declared as a CONTRACT fuel surcharge — `confirmed` / `formula` — which is
 * what keeps it reliable; a lumper reimbursement in the same bucket would be
 * `claim` and would not be (that is T14, and it is the F-4 fix).
 *
 * Two goldens changed value and both are R3-8 / R3-6 consequences:
 *   G07  used `overhead_cents_per_day: 0` to strip costs. A zero overhead is now
 *        a MISSING FACT, not a value, so it uses 1c/day and carries 2c of
 *        overhead. Net moves 115625 → 115623.
 *   G12  runs a 720-minute trip, which is exactly the half-day overhead floor,
 *        so its figures are untouched. It now also pins the floor's boundary.
 *
 * The base load, reused by most cases:
 *   revenue      linehaul 200000c (confirmed/formula)
 *                fuelSurcharge 30000c (passThrough, confirmed/formula)  → gross 230000c
 *   distance     1000 loaded + 100 deadhead + 0 reposition              → 1100 total
 *   fuel         5.000 mpg loaded / 8.000 mpg empty, 400c posted less 50c → 350c effective
 *                loaded 1000*1000*350/5000 = 70000c
 *                empty   100*1000*350/8000 =  4375c                     → 74375c
 *   DEF 0 ; idle fuel 0 gal ; lumper cash 0 ; weight-distance/IFTA 0 ; factoring none
 *   tolls 5000c ; scale/permit/other cash 2000c
 *   reserves     15c/mi * 1100 = 16500c ; 4c/mi * 1100 = 4400c
 *   overhead     20000c/day * max(2880, 720) min / 1440 = 40000c
 *   driver pay   25% of LINEHAUL only = 50000c
 *   haircut      0bp = 0c
 *   allCosts     74375+0+0+5000+0+2000+16500+4400+40000+0+0+50000+0 = 192275c
 *   net          230000 - 192275 = 37725c
 *   thresholds   break-even 180c/mi -> 198000c ; target 220c/mi -> 242000c
 */

/** The base load's three revenue amounts, rebuilt as declared lines by `load()`. */
type RevenueKnobs = {
  /** bucket linehaul, confirmed, formula. */
  linehaul?: number;
  /** bucket passThrough, confirmed, formula — a CONTRACT fuel surcharge. */
  passThrough?: number;
  /** bucket otherAccessorial, confirmed, claim — confirmed detention. */
  other?: number;
  /** Replaces the three knobs entirely when a case needs its own line shapes. */
  lines?: readonly RevenueLine[];
};

type LoadOverrides = Partial<Omit<TrueNetInput, "revenueLines">> & RevenueKnobs;

function revenueLinesFrom(k: RevenueKnobs): RevenueLine[] {
  if (k.lines !== undefined) return [...k.lines];
  const linehaul = k.linehaul ?? 200_000;
  const passThrough = k.passThrough ?? 30_000;
  const other = k.other ?? 0;
  const lines: RevenueLine[] = [];
  // `!== 0` rather than `> 0`: a zero-amount line contributes nothing and is simply
  // left off, but a negative or non-integer amount must still reach the calculator's
  // own validation rather than being silently dropped here.
  if (linehaul !== 0) {
    lines.push({
      id: "linehaul",
      bucket: "linehaul",
      amount_cents: linehaul,
      settlementState: "confirmed",
      reliability: "formula",
    });
  }
  if (passThrough !== 0) {
    lines.push({
      id: "fuelSurcharge",
      bucket: "passThrough",
      amount_cents: passThrough,
      settlementState: "confirmed",
      reliability: "formula",
    });
  }
  if (other !== 0) {
    lines.push({
      id: "detention",
      bucket: "otherAccessorial",
      amount_cents: other,
      settlementState: "confirmed",
      reliability: "claim",
    });
  }
  return lines;
}

const BASE: Omit<TrueNetInput, "revenueLines"> = {
  loadedMiles: 1000,
  deadheadMiles: 100,
  repositionMiles: 0,
  mpgLoaded_milli: 5000,
  mpgEmpty_milli: 8000,
  regionalDieselPrice_cents_per_gal: 400,
  fuelDiscount_cents_per_gal: 50,
  // R3-4: the six cost lines new in Rev 3, all at a confirmed zero on the base
  // load so every Rev 2 golden figure stays exactly where it was.
  def_cents: 0,
  idleFuelGallons_milli: 0,
  tolls_cents: 5000,
  lumperCost_cents: 0,
  scalePermitOtherCash_cents: 2000, // renamed from knownExpenses_cents
  maintenanceReserve_cents_per_mile: 15,
  tireReserve_cents_per_mile: 4,
  weightDistanceAndIfta_cents: 0,
  tripMinutes: 2880,
  overhead_cents_per_day: 20000,
  driverPay: { type: "percent", percent_bp: 2500 },
  brokerOrDispatchHaircut_bp: 0,
  // 3B-R3: third_party keeps every golden figure exactly where Rev 2 left it.
  settlementMode: "third_party",
  factoringBase: "none",
  factoringOrQuickPay_bp: 0,
  dieselPriceSnapshotId: "test:eia-padd3:2026-09-08",
  breakEven_cents_per_mile: 180,
  target_cents_per_mile: 220,
};

function load(overrides: LoadOverrides = {}): TrueNetInput {
  const { linehaul, passThrough, other, lines, ...rest } = overrides;
  return {
    ...BASE,
    ...rest,
    revenueLines: revenueLinesFrom({ linehaul, passThrough, other, lines }),
  };
}

/**
 * Every golden case expects OK; this keeps the narrowing out of each one.
 *
 * T15 LIVES HERE. The spec asks that the bucket sum be asserted "as a property
 * rather than per-case", so both Rev 3 partitions are checked on EVERY result
 * this suite ever produces — all twenty goldens, every generated load, every
 * edge case below — rather than in one describe block that a future fixture
 * could quietly route around.
 */
function ok(input: Partial<TrueNetInput>): TrueNetOk {
  const result = calculateTrueNet(input);
  if (result.status !== "OK") {
    throw new Error(`expected OK, got NEEDS_INPUT missing [${result.missing.join(", ")}]`);
  }
  // T15 / R3-3, partition by bucket.
  expect(
    result.linehaulRevenue_cents +
      result.passThroughRevenue_cents +
      result.otherAccessorialRevenue_cents,
  ).toBe(result.grossRevenue_cents);
  // R3-1/R3-2, partition by classification. Rev 2 had only two classes and an
  // unconfirmed line fell out of both AND out of gross — that was F-5.
  expect(
    result.reliableRevenue_cents +
      result.atRiskAccessorialRevenue_cents +
      result.unconfirmedRevenue_cents,
  ).toBe(result.grossRevenue_cents);
  return result;
}

describe("20 golden loads — to the cent", () => {
  // G01 base. See the header block for the full derivation.
  it("G01 base load — negotiate", () => {
    expect(ok(load())).toMatchObject({
      grossRevenue_cents: 230000,
      totalMiles: 1100,
      emptyMiles: 100,
      effectiveDieselPrice_cents_per_gal: 350,
      fuelCost_cents: 74375,
      maintenanceReserve_cents: 16500,
      tireReserve_cents: 4400,
      overhead_cents: 40000,
      driverPay_cents: 50000,
      brokerOrDispatchHaircut_cents: 0,
      allCosts_cents: 192275,
      trueEstimatedNet_cents: 37725,
      allInRpm_millicents_per_mile: 209091, // 230000*1000/1100 = 209090.90 -> 209091
      netPerAvailableDay_cents: 18863, // 37725*1440/2880 = 18862.5 -> 18863
      breakEvenRate_cents: 198000,
      recommendedBid_cents: 242000,
      floorRate_cents: 198000,
      verdict: "negotiate",
    });
  });

  // G02 [Rev 2, F-1] confirmed detention is CONFIRMED, not PAID. other 15000 -> gross 245000
  //     (still the true all-in total for 6E), but reliable = 200000+30000 = 230000 < target
  //     242000 -> negotiate, NOT take. net = 230000-192275 = 37725 (unchanged from G01);
  //     at-risk 15000 ; upside 37725+15000 = 52725. Rev 1 said "take" on this load - that was
  //     the defect: a verdict on the strength of detention that may never be paid.
  it("G02 confirmed-but-unsettled detention lands in at-risk and does NOT move the verdict — negotiate", () => {
    const r = ok(load({ other: 15000, detentionTermsKnown: true }));
    expect(r).toMatchObject({
      grossRevenue_cents: 245000,
      reliableRevenue_cents: 230000,
      atRiskAccessorialRevenue_cents: 15000,
      unconfirmedRevenue_cents: 0,
      upsideIfAllAccessorialsPay_cents: 52725,
      trueEstimatedNet_cents: 37725,
      netPerAvailableDay_cents: 18863,
      verdict: "negotiate",
    });
    // The same load with the detention removed reaches the identical verdict and net.
    const without = ok(load({ detentionTermsKnown: true }));
    expect(without.verdict).toBe(r.verdict);
    expect(without.trueEstimatedNet_cents).toBe(r.trueEstimatedNet_cents);
    expect(r.riskFlags).toContainEqual(
      expect.stringMatching(/15000c of confirmed accessorials is at risk/),
    );
    expect(r.reasons).toContainEqual(expect.stringMatching(/not counted toward this verdict/));
  });

  // G03 percent pay is LINEHAUL ONLY: pass-through 30000 -> 100000 raises gross to 300000
  //     but driver pay stays 50000. cost unchanged 192275 ; net 107725
  //     107725*1440/2880 = 53862.5 -> 53863
  it("G03 pass-through revenue does not raise percent driver pay — take", () => {
    expect(ok(load({ passThrough: 100000 }))).toMatchObject({
      grossRevenue_cents: 300000,
      driverPay_cents: 50000,
      allCosts_cents: 192275,
      trueEstimatedNet_cents: 107725,
      netPerAvailableDay_cents: 53863,
      verdict: "take",
    });
  });

  // G04 haircut is LINEHAUL ONLY: 1000bp of 200000 = 20000, not 10% of gross 300000.
  //     cost 192275+20000 = 212275 ; net 300000-212275 = 87725 ; /day 43862.5 -> 43863
  it("G04 haircut applies to linehaul only — take", () => {
    expect(ok(load({ passThrough: 100000, brokerOrDispatchHaircut_bp: 1000 }))).toMatchObject({
      grossRevenue_cents: 300000,
      brokerOrDispatchHaircut_cents: 20000,
      allCosts_cents: 212275,
      trueEstimatedNet_cents: 87725,
      netPerAvailableDay_cents: 43863,
      verdict: "take",
    });
  });

  // G05 larger per-gallon discount lowers fuel cost: effective 300c
  //     loaded 1000*1000*300/5000 = 60000 ; empty 100*1000*300/8000 = 3750 -> 63750
  //     cost 192275-74375+63750 = 181650 ; net 48350 ; /day 24175
  it("G05 larger per-gallon discount lowers fuel cost — negotiate", () => {
    expect(ok(load({ fuelDiscount_cents_per_gal: 100 }))).toMatchObject({
      effectiveDieselPrice_cents_per_gal: 300,
      fuelCost_cents: 63750,
      allCosts_cents: 181650,
      trueEstimatedNet_cents: 48350,
      netPerAvailableDay_cents: 24175,
      verdict: "negotiate",
    });
  });

  // G06 negative net forces skip regardless of thresholds.
  //     linehaul 50000 -> gross 50000 ; pay 12500 ; cost 74375+5000+2000+16500+4400+40000+12500 = 154775
  //     net -104775 ; /day -(104775*1440/2880 = 52387.5 -> 52388)
  it("G06 negative net — skip", () => {
    expect(ok(load({ linehaul: 50000, passThrough: 0 }))).toMatchObject({
      grossRevenue_cents: 50000,
      driverPay_cents: 12500,
      allCosts_cents: 154775,
      trueEstimatedNet_cents: -104775,
      netPerAvailableDay_cents: -52388,
      verdict: "skip",
    });
  });

  // G07 positive net but below the carrier's break-even -> still skip.
  //     [R3-8, CHANGED IN REV 3] this case used overhead 0 to strip costs; a zero overhead is
  //     now a MISSING FACT, so it uses the smallest real figure, 1c/day:
  //     overhead = 1 * max(2880,720) / 1440 = 2c.
  //     all costs stripped except fuel 74375 + overhead 2 = 74377 ; gross 190000 ; net 115623
  //     190000 < breakEvenRate 198000 ; /day 115623*1440/2880 = 57811.5 -> 57812
  it("G07 positive net but under break-even — skip", () => {
    expect(
      ok(
        load({
          linehaul: 190000,
          passThrough: 0,
          tolls_cents: 0,
          maintenanceReserve_cents_per_mile: 0,
          tireReserve_cents_per_mile: 0,
          scalePermitOtherCash_cents: 0,
          overhead_cents_per_day: 1,
          driverPay: { type: "none" },
        }),
      ),
    ).toMatchObject({
      grossRevenue_cents: 190000,
      overhead_cents: 2,
      allCosts_cents: 74377,
      trueEstimatedNet_cents: 115623,
      netPerAvailableDay_cents: 57812,
      breakEvenRate_cents: 198000,
      verdict: "skip",
    });
  });

  // G08 boundary: reliable exactly equals the target -> take (inclusive).
  //     linehaul 242000 ; pay 25% = 60500 ; cost 74375+5000+2000+16500+4400+40000+60500 = 202775
  //     net 39225 ; rpm 242000*1000/1100 = 220000 ; /day 39225*1440/2880 = 19612.5 -> 19613
  it("G08 gross exactly at target — take", () => {
    expect(ok(load({ linehaul: 242000, passThrough: 0 }))).toMatchObject({
      grossRevenue_cents: 242000,
      driverPay_cents: 60500,
      allCosts_cents: 202775,
      trueEstimatedNet_cents: 39225,
      allInRpm_millicents_per_mile: 220000,
      netPerAvailableDay_cents: 19613,
      verdict: "take",
    });
  });

  // G09 boundary: reliable exactly equals break-even -> negotiate (inclusive).
  //     linehaul 198000 ; pay 49500 ; cost 74375+5000+2000+16500+4400+40000+49500 = 191775
  //     net 6225 ; rpm 180000 ; /day 6225*1440/2880 = 3112.5 -> 3113
  it("G09 gross exactly at break-even — negotiate", () => {
    expect(ok(load({ linehaul: 198000, passThrough: 0 }))).toMatchObject({
      grossRevenue_cents: 198000,
      driverPay_cents: 49500,
      allCosts_cents: 191775,
      trueEstimatedNet_cents: 6225,
      allInRpm_millicents_per_mile: 180000,
      netPerAvailableDay_cents: 3113,
      verdict: "negotiate",
    });
  });

  // G10 per-mile pay covers every mile: 60c * 1100 = 66000
  //     cost 192275-50000+66000 = 208275 ; net 21725 ; /day 10862.5 -> 10863
  it("G10 per-mile driver pay covers loaded and empty miles — negotiate", () => {
    expect(ok(load({ driverPay: { type: "perMile", rate_cents_per_mile: 60 } }))).toMatchObject({
      driverPay_cents: 66000,
      allCosts_cents: 208275,
      trueEstimatedNet_cents: 21725,
      netPerAvailableDay_cents: 10863,
      verdict: "negotiate",
    });
  });

  // G11 owner-operator taking no pay line: cost 192275-50000 = 142275 ; net 87725 ; /day 43863
  it("G11 no driver pay line — negotiate", () => {
    expect(ok(load({ driverPay: { type: "none" } }))).toMatchObject({
      driverPay_cents: 0,
      allCosts_cents: 142275,
      trueEstimatedNet_cents: 87725,
      netPerAvailableDay_cents: 43863,
      verdict: "negotiate",
    });
  });

  // G12 half-way rounding rounds away from zero in all three places at once:
  //     overhead   1*max(720,720)/1440 = 0.5 -> 1   [R3-6: 720 min IS the half-day floor,
  //                                                  so this case also pins the boundary]
  //     driver pay 100*50/10000 = 0.5 -> 1
  //     haircut    100*50/10000 = 0.5 -> 1
  //     fuel 1*1000*10/1000 = 10 ; cost 10+1+1+1 = 13 ; net 100-13 = 87
  //     rpm 100*1000/1 = 100000 ; /day 87*1440/720 = 174
  it("G12 exact halves round away from zero — take", () => {
    expect(
      ok({
        revenueLines: [
          {
            id: "linehaul",
            bucket: "linehaul",
            amount_cents: 100,
            settlementState: "confirmed",
            reliability: "formula",
          },
        ],
        loadedMiles: 1,
        deadheadMiles: 0,
        repositionMiles: 0,
        mpgLoaded_milli: 1000,
        mpgEmpty_milli: 1000,
        regionalDieselPrice_cents_per_gal: 10,
        fuelDiscount_cents_per_gal: 0,
        def_cents: 0,
        idleFuelGallons_milli: 0,
        tolls_cents: 0,
        lumperCost_cents: 0,
        scalePermitOtherCash_cents: 0,
        maintenanceReserve_cents_per_mile: 0,
        tireReserve_cents_per_mile: 0,
        weightDistanceAndIfta_cents: 0,
        tripMinutes: 720,
        overhead_cents_per_day: 1,
        driverPay: { type: "percent", percent_bp: 50 },
        brokerOrDispatchHaircut_bp: 50,
        settlementMode: "third_party",
        factoringBase: "none",
        factoringOrQuickPay_bp: 0,
        dieselPriceSnapshotId: "test:g12",
        breakEven_cents_per_mile: 1,
        target_cents_per_mile: 2,
      }),
    ).toMatchObject({
      fuelCost_cents: 10,
      overhead_cents: 1,
      driverPay_cents: 1,
      brokerOrDispatchHaircut_cents: 1,
      allCosts_cents: 13,
      trueEstimatedNet_cents: 87,
      allInRpm_millicents_per_mile: 100000,
      netPerAvailableDay_cents: 174,
      verdict: "take",
    });
  });

  // G13 awkward numbers: linehaul 111111 -> pay 111111*2500/10000 = 27777.75 -> 27778
  //     gross 111111+22222+3333 = 136666
  //     cost 74375+5000+2000+16500+4400+40000+27778 = 170053
  //     [Rev 2] reliable 111111+22222 = 133333 ; net 133333-170053 = -36720 -> skip ; at-risk 3333
  //     upside -36720+3333 = -33387 (Rev 1's net). rpm stays gross-based: 136666000/1100 -> 124242
  //     /day -36720*1440/2880 = -18360 exactly
  it("G13 non-round inputs round once, at the end — skip", () => {
    expect(ok(load({ linehaul: 111111, passThrough: 22222, other: 3333 }))).toMatchObject({
      grossRevenue_cents: 136666,
      reliableRevenue_cents: 133333,
      atRiskAccessorialRevenue_cents: 3333,
      upsideIfAllAccessorialsPay_cents: -33387,
      driverPay_cents: 27778,
      allCosts_cents: 170053,
      trueEstimatedNet_cents: -36720,
      allInRpm_millicents_per_mile: 124242,
      netPerAvailableDay_cents: -18360,
      verdict: "skip",
    });
  });

  // G14 smaller confirmed detention: other 7500 -> gross 237500 ; rpm 237500000/1100 -> 215909
  //     [Rev 2] reliable 230000 < 242000 -> negotiate ; net 230000-192275 = 37725 ; /day 18863
  //     at-risk 7500 ; upside 45225 (Rev 1's net)
  it("G14 confirmed detention below target — negotiate", () => {
    expect(ok(load({ other: 7500, detentionTermsKnown: true }))).toMatchObject({
      grossRevenue_cents: 237500,
      reliableRevenue_cents: 230000,
      atRiskAccessorialRevenue_cents: 7500,
      upsideIfAllAccessorialsPay_cents: 45225,
      trueEstimatedNet_cents: 37725,
      allInRpm_millicents_per_mile: 215909,
      netPerAvailableDay_cents: 18863,
      verdict: "negotiate",
    });
  });

  // G15 no fuel card: discount 0 -> 400c effective.
  //     loaded 1000*1000*400/5000 = 80000 ; empty 100*1000*400/8000 = 5000 ; fuel 85000
  //     cost 85000+5000+2000+16500+4400+40000+50000 = 202900 ; net 27100 ; /day 13550
  it("G15 no fuel discount — negotiate", () => {
    expect(ok(load({ fuelDiscount_cents_per_gal: 0 }))).toMatchObject({
      effectiveDieselPrice_cents_per_gal: 400,
      fuelCost_cents: 85000,
      allCosts_cents: 202900,
      trueEstimatedNet_cents: 27100,
      netPerAvailableDay_cents: 13550,
      verdict: "negotiate",
    });
  });

  // G16 toll-heavy lane tips a workable load negative.
  //     tolls 50000 ; cost 192275-5000+50000 = 237275 ; net -7275
  //     /day -(7275*1440/2880 = 3637.5 -> 3638)
  it("G16 heavy tolls turn the load negative — skip", () => {
    expect(ok(load({ tolls_cents: 50000 }))).toMatchObject({
      allCosts_cents: 237275,
      trueEstimatedNet_cents: -7275,
      netPerAvailableDay_cents: -3638,
      verdict: "skip",
    });
  });

  // G17 pure loaded run, no empty miles at all. 500 loaded, 0 empty -> 500 total.
  //     fuel 500*1000*350/5000 = 35000 ; reserves 15*500 = 7500, 4*500 = 2000
  //     pay 25% of 150000 = 37500 ; cost 35000+5000+2000+7500+2000+40000+37500 = 129000
  //     net 150000-129000 = 21000 ; break-even 180*500 = 90000 ; target 220*500 = 110000
  //     rpm 150000000/500 = 300000 ; /day 21000*1440/2880 = 10500
  it("G17 no empty miles — take", () => {
    expect(
      ok(
        load({
          linehaul: 150000,
          passThrough: 0,
          loadedMiles: 500,
          deadheadMiles: 0,
          repositionMiles: 0,
        }),
      ),
    ).toMatchObject({
      emptyMiles: 0,
      totalMiles: 500,
      fuelCost_cents: 35000,
      driverPay_cents: 37500,
      allCosts_cents: 129000,
      trueEstimatedNet_cents: 21000,
      breakEvenRate_cents: 90000,
      recommendedBid_cents: 110000,
      allInRpm_millicents_per_mile: 300000,
      netPerAvailableDay_cents: 10500,
      verdict: "take",
    });
  });

  // G18 reposition miles are empty miles: 50 deadhead + 50 reposition == 100 deadhead.
  //     Identical to G01 in every figure.
  it("G18 reposition miles burn fuel at the empty rate — identical to G01", () => {
    expect(ok(load({ deadheadMiles: 50, repositionMiles: 50 }))).toMatchObject({
      emptyMiles: 100,
      totalMiles: 1100,
      fuelCost_cents: 74375,
      allCosts_cents: 192275,
      trueEstimatedNet_cents: 37725,
      verdict: "negotiate",
    });
  });

  // G19 percent that rounds DOWN: 123457*3333/10000 = 41148.2181 -> 41148
  //     gross 123457 ; cost 74375+5000+2000+16500+4400+40000+41148 = 183423 ; net -59966
  //     rpm 123457000/1100 = 112233.6 -> 112234 ; /day -(59966*1440/2880 = 29983)
  it("G19 percent pay rounds down when below the half — skip", () => {
    expect(
      ok(
        load({
          linehaul: 123457,
          passThrough: 0,
          driverPay: { type: "percent", percent_bp: 3333 },
        }),
      ),
    ).toMatchObject({
      driverPay_cents: 41148,
      allCosts_cents: 183423,
      trueEstimatedNet_cents: -59966,
      allInRpm_millicents_per_mile: 112234,
      netPerAvailableDay_cents: -29983,
      verdict: "skip",
    });
  });

  // G20 dispatch-service shape: no driver pay line, 10% dispatch fee on linehaul.
  //     haircut 20000 ; cost 74375+5000+2000+16500+4400+40000+0+20000 = 162275
  //     net 67725 ; /day 67725*1440/2880 = 33862.5 -> 33863
  it("G20 dispatch fee instead of driver pay — negotiate", () => {
    expect(
      ok(load({ driverPay: { type: "none" }, brokerOrDispatchHaircut_bp: 1000 })),
    ).toMatchObject({
      driverPay_cents: 0,
      brokerOrDispatchHaircut_cents: 20000,
      allCosts_cents: 162275,
      trueEstimatedNet_cents: 67725,
      netPerAvailableDay_cents: 33863,
      verdict: "negotiate",
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC-3B Rev 3 (3B-R4) — the six REQUIRED vectors, T3 T4 T5 T6 T9 T10,
// plus the three new ones, T13 T14 T15.
// ---------------------------------------------------------------------------

describe("[T3] half-cent pay — every fee computed independently from linehaul", () => {
  // linehaul 10002 : 25% = 2500.5 -> 2501 (half away from zero)
  //                   6% =  600.12 -> 600
  // Chained, 6% of (10002-2501) = 450.06 -> 450, which is NOT what a dispatch
  // agreement says. Independence is the assertion.
  it("linehaul 10002: driver 25% -> 2501 and dispatch 6% -> 600, neither taken off the other", () => {
    const r = ok(
      load({
        linehaul: 10002,
        passThrough: 0,
        driverPay: { type: "percent", percent_bp: 2500 },
        brokerOrDispatchHaircut_bp: 600,
      }),
    );
    expect(r.driverPay_cents).toBe(2501);
    expect(r.brokerOrDispatchHaircut_cents).toBe(600);
    // the chained figures, asserted absent
    expect(r.brokerOrDispatchHaircut_cents).not.toBe(450);
    expect(r.assumptions.feeOrderBasis).toMatch(/never stacked/);
  });
});

describe("[T4] sub-cent percentages round half away from zero", () => {
  // 6% of 9 = 0.54 -> 1 ; 6% of 8 = 0.48 -> 0. Truncation would give 0 for both
  // and quietly lose a cent on every small line in the system.
  it("6% of 9 -> 1", () => {
    expect(
      ok(load({ linehaul: 9, passThrough: 0, brokerOrDispatchHaircut_bp: 600 }))
        .brokerOrDispatchHaircut_cents,
    ).toBe(1);
  });

  it("companion: 6% of 8 -> 0", () => {
    expect(
      ok(load({ linehaul: 8, passThrough: 0, brokerOrDispatchHaircut_bp: 600 }))
        .brokerOrDispatchHaircut_cents,
    ).toBe(0);
  });
});

describe("[T5] negative net under a fat gross — goldened against a future 'helpful' fix", () => {
  /*
   * The load that this case exists to protect against: gross 270000 beats the
   * 242000 target, and the upside figure is POSITIVE (+102725), so anyone
   * eyeballing the screen sees a good load. The reliable figure is 120000, the
   * net is -47275, and the verdict is skip.
   *
   *   linehaul      100000 confirmed/formula  -> reliable
   *   fuelSurcharge  20000 confirmed/formula  -> reliable
   *   detention     150000 confirmed/claim    -> at-risk
   *   gross 270000 ; reliable 120000 ; at-risk 150000
   *   pay 25% of 100000 = 25000
   *   cost 74375+5000+2000+16500+4400+40000+25000 = 167275
   *   net 120000-167275 = -47275 ; upside -47275+150000 = 102725
   *   rpm 270000000/1100 = 245454.5 -> 245455
   *   /day -(47275*1440/2880 = 23637.5 -> 23638)
   *
   * If a later change folds at-risk dollars back into the verdict, this case
   * turns green-to-take and the test goes red. That is its entire job.
   */
  it("a fat gross and a positive upside do not rescue a negative reliable net", () => {
    const r = ok(
      load({ linehaul: 100000, passThrough: 20000, other: 150000, detentionTermsKnown: true }),
    );
    expect(r).toMatchObject({
      grossRevenue_cents: 270000,
      reliableRevenue_cents: 120000,
      atRiskAccessorialRevenue_cents: 150000,
      allCosts_cents: 167275,
      trueEstimatedNet_cents: -47275,
      upsideIfAllAccessorialsPay_cents: 102725,
      allInRpm_millicents_per_mile: 245455,
      netPerAvailableDay_cents: -23638,
      verdict: "skip",
    });
    // gross clears the target; the verdict does not look at gross.
    expect(r.grossRevenue_cents).toBeGreaterThan(r.recommendedBid_cents);
    expect(r.upsideIfAllAccessorialsPay_cents).toBeGreaterThan(0);
  });
});

describe("[T6] zero loaded miles — a TONU still prices", () => {
  /*
   *   tonu 40000 otherAccessorial/confirmed/claim -> at-risk, NOT reliable
   *   0 loaded + 150 deadhead = 150 total
   *   fuel loaded 0 ; empty 150*1000*350/8000 = 6562.5 -> 6563
   *   cost 6563+5000+2000+(15*150=2250)+(4*150=600)+40000 = 56413 ; pay 25% of 0 = 0
   *   net 0-56413 = -56413 ; rpm 40000000/150 = 266666.67 -> 266667
   *   /day -(56413*1440/2880 = 28206.5 -> 28207)
   *   break-even 180*150 = 27000 ; target 220*150 = 33000
   */
  it("prices a killed load with deadhead but no loaded miles — skip", () => {
    const r = ok(
      load({
        lines: [
          {
            id: "tonu",
            bucket: "otherAccessorial",
            amount_cents: 40000,
            settlementState: "confirmed",
            reliability: "claim",
          },
        ],
        loadedMiles: 0,
        deadheadMiles: 150,
        repositionMiles: 0,
        detentionTermsKnown: true,
      }),
    );
    expect(r).toMatchObject({
      loadedMiles: 0,
      emptyMiles: 150,
      totalMiles: 150,
      grossRevenue_cents: 40000,
      reliableRevenue_cents: 0,
      atRiskAccessorialRevenue_cents: 40000,
      fuelCost_cents: 6563,
      driverPay_cents: 0,
      allCosts_cents: 56413,
      trueEstimatedNet_cents: -56413,
      allInRpm_millicents_per_mile: 266667,
      netPerAvailableDay_cents: -28207,
      breakEvenRate_cents: 27000,
      recommendedBid_cents: 33000,
      verdict: "skip",
    });
  });

  it("but a load with no distance at all cannot be priced and throws", () => {
    expect(() =>
      calculateTrueNet(load({ loadedMiles: 0, deadheadMiles: 0, repositionMiles: 0 })),
    ).toThrow(/no distance/);
  });
});

describe("[T9, R3-8] partial configuration is worse than none", () => {
  it("an empty input names every missing field rather than pricing a fantasy", () => {
    const result = calculateTrueNet({});
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    expect(result.calcVersion).toBe(CALC_VERSION);
    for (const field of [
      "revenueLines",
      "loadedMiles",
      "mpgLoaded_milli",
      "overhead_cents_per_day",
      "tolls_cents",
      "def_cents",
      "idleFuelGallons_milli",
      "lumperCost_cents",
      "scalePermitOtherCash_cents",
      "weightDistanceAndIfta_cents",
      "factoringBase",
      "settlementMode",
      "driverPay",
      "dieselPriceSnapshotId",
    ]) {
      expect(result.missing).toContain(field);
    }
  });

  /*
   * The companion case the spec calls for by name. Before R3-8 this returned a
   * perfectly valid OK with overhead_cents 0 — a silent zero-cost truck, which
   * is a fully "valid" calculation of a fantasy.
   *
   * NOTE ON THE FIELD NAME: the ticket writes this as `NEEDS_INPUT: overheadPerDay`.
   * The missing list returns the REAL input field name, `overhead_cents_per_day`,
   * because a caller has to be able to act on what comes back and there is no
   * field called `overheadPerDay` to set.
   */
  it("MPG present, overhead absent -> NEEDS_INPUT naming overhead, never 0", () => {
    const { overhead_cents_per_day: _omitted, ...rest } = load();
    const result = calculateTrueNet(rest);
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    expect(result.missing).toEqual(["overhead_cents_per_day"]);
  });

  it("a configured overhead of ZERO is the same missing fact, not a value", () => {
    const result = calculateTrueNet(load({ overhead_cents_per_day: 0 }));
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    expect(result.missing).toEqual(["overhead_cents_per_day"]);
  });

  it("but a zero IS accepted where a zero is real — tolls, DEF, IFTA, owner-driven pay", () => {
    const r = ok(
      load({
        tolls_cents: 0,
        def_cents: 0,
        weightDistanceAndIfta_cents: 0,
        driverPay: { type: "none" },
      }),
    );
    expect(r.tolls_cents).toBe(0);
    expect(r.def_cents).toBe(0);
    expect(r.weightDistanceAndIfta_cents).toBe(0);
    expect(r.driverPay_cents).toBe(0);
    expect(r.assumptions.defBasis).toMatch(/confirmed zero/);
  });
});

describe("[T10, R3-5] do not sell infinite MPG", () => {
  it("throws when the discount EXCEEDS the posted price", () => {
    expect(() =>
      calculateTrueNet(
        load({ regionalDieselPrice_cents_per_gal: 100, fuelDiscount_cents_per_gal: 200 }),
      ),
    ).toThrow(/do not sell infinite MPG/);
  });

  it("throws when the discount EQUALS the posted price — free fuel is not a load", () => {
    expect(() =>
      calculateTrueNet(
        load({ regionalDieselPrice_cents_per_gal: 400, fuelDiscount_cents_per_gal: 400 }),
      ),
    ).toThrow(TrueNetError);
  });

  it("one cent under the posted price is still a real load", () => {
    const r = ok(load({ regionalDieselPrice_cents_per_gal: 400, fuelDiscount_cents_per_gal: 399 }));
    expect(r.effectiveDieselPrice_cents_per_gal).toBe(1);
    // loaded 1000*1000*1/5000 = 200 ; empty 100*1000*1/8000 = 12.5 -> 13
    expect(r.fuelCost_cents).toBe(213);
  });
});

describe("[T13, R3-1/F-5] an unconfirmed fuel surcharge is in gross and nowhere else", () => {
  /*
   * The ordinary case Rev 2 was blind to: an index FSC quoted "TBD at invoice".
   * Rev 2 dropped it out of all three buckets INCLUDING gross, so a "does gross
   * look healthy?" check could not see it at all.
   *
   *   linehaul      200000 confirmed/formula   -> reliable
   *   fuelSurcharge  30000 UNCONFIRMED/formula -> unconfirmed
   *   gross 230000 ; reliable 200000 ; at-risk 0 ; unconfirmed 30000
   *   cost 192275 ; net 200000-192275 = 7725 ; /day 7725*1440/2880 = 3862.5 -> 3863
   *   reliable 200000 >= break-even 198000, < target 242000 -> negotiate
   */
  const unconfirmedFsc = load({
    lines: [
      {
        id: "linehaul",
        bucket: "linehaul",
        amount_cents: 200_000,
        settlementState: "confirmed",
        reliability: "formula",
      },
      {
        id: "fuelSurcharge",
        bucket: "passThrough",
        amount_cents: 30_000,
        settlementState: "unconfirmed",
        reliability: "formula",
      },
    ],
    detentionTermsKnown: true,
  });

  it("appears in grossRevenue_cents", () => {
    expect(ok(unconfirmedFsc).grossRevenue_cents).toBe(230000);
  });

  it("appears in NEITHER reliable nor at-risk", () => {
    const r = ok(unconfirmedFsc);
    expect(r.reliableRevenue_cents).toBe(200000);
    expect(r.atRiskAccessorialRevenue_cents).toBe(0);
    expect(r.unconfirmedRevenue_cents).toBe(30000);
  });

  it("raises a missing-fact flag naming the line", () => {
    const r = ok(unconfirmedFsc);
    expect(r.missingFacts).toContain("fuelSurcharge");
    expect(r.riskFlags).toContainEqual(
      expect.stringMatching(/"fuelSurcharge" is on the load with no agreed figure/),
    );
  });

  it("is excluded from the net and from the verdict", () => {
    const r = ok(unconfirmedFsc);
    expect(r.trueEstimatedNet_cents).toBe(7725);
    expect(r.netPerAvailableDay_cents).toBe(3863);
    expect(r.verdict).toBe("negotiate");
    // and it is NOT in the upside either — there is no agreed figure to add.
    expect(r.upsideIfAllAccessorialsPay_cents).toBe(7725);
    expect(r.reasons).toContainEqual(expect.stringMatching(/Unconfirmed revenue lines/));
  });

  it("confirming the same line moves it into reliable and raises the net by the full amount", () => {
    const unconfirmed = ok(unconfirmedFsc);
    const confirmed = ok(load({ detentionTermsKnown: true })); // same amounts, FSC confirmed
    expect(confirmed.reliableRevenue_cents - unconfirmed.reliableRevenue_cents).toBe(30000);
    expect(confirmed.trueEstimatedNet_cents - unconfirmed.trueEstimatedNet_cents).toBe(30000);
    expect(confirmed.grossRevenue_cents).toBe(unconfirmed.grossRevenue_cents);
  });
});

describe("[T14, R3-2/F-4] a confirmed lumper reimbursement is a CLAIM, not reliable revenue", () => {
  /*
   * The F-4 fix, and the one that moves a real headline number. A confirmed
   * lumper reimbursement sits in the pass-through BUCKET, exactly where Rev 2
   * banked it as reliable — but it depends on a broker honouring a receipt, so
   * its RELIABILITY is "claim" and it is at-risk.
   *
   *   linehaul             200000 confirmed/formula          -> reliable
   *   fuelSurcharge         30000 confirmed/formula           -> reliable
   *   lumperReimbursement   12000 passThrough confirmed/CLAIM -> AT-RISK
   *   lumperCost_cents      12000 cash out at the dock
   *   buckets   linehaul 200000 + passThrough 42000 + other 0 = gross 242000
   *   classes   reliable 230000 + at-risk 12000 + unconfirmed 0 = gross 242000
   *   cost 192275 + 12000 = 204275 ; net 230000-204275 = 25725
   *   /day 25725*1440/2880 = 12862.5 -> 12863 ; upside 25725+12000 = 37725
   */
  const withLumper = load({
    lines: [
      {
        id: "linehaul",
        bucket: "linehaul",
        amount_cents: 200_000,
        settlementState: "confirmed",
        reliability: "formula",
      },
      {
        id: "fuelSurcharge",
        bucket: "passThrough",
        amount_cents: 30_000,
        settlementState: "confirmed",
        reliability: "formula",
      },
      {
        id: "lumperReimbursement",
        bucket: "passThrough",
        amount_cents: 12_000,
        settlementState: "confirmed",
        reliability: "claim",
      },
    ],
    lumperCost_cents: 12_000,
    detentionTermsKnown: true,
  });

  it("lands in at-risk even though its bucket is pass-through", () => {
    const r = ok(withLumper);
    expect(r.passThroughRevenue_cents).toBe(42000);
    expect(r.reliableRevenue_cents).toBe(230000); // NOT 242000 — this is the F-4 fix
    expect(r.atRiskAccessorialRevenue_cents).toBe(12000);
    expect(
      r.classifiedRevenueLines.find((l) => l.id === "lumperReimbursement")?.classification,
    ).toBe("atRisk");
  });

  it("does not move the verdict", () => {
    expect(ok(withLumper).verdict).toBe(ok(load({ detentionTermsKnown: true })).verdict);
  });

  it("and the matching lumperCost reduces the net by the full amount", () => {
    const r = ok(withLumper);
    const base = ok(load({ detentionTermsKnown: true }));
    expect(r.lumperCost_cents).toBe(12000);
    expect(r.allCosts_cents).toBe(204275);
    expect(r.trueEstimatedNet_cents).toBe(25725);
    expect(base.trueEstimatedNet_cents - r.trueEstimatedNet_cents).toBe(12000);
    expect(r.netPerAvailableDay_cents).toBe(12863);
    expect(r.upsideIfAllAccessorialsPay_cents).toBe(37725);
  });

  it("the cash out and the reimbursement are independent — paying a lumper nobody reimburses still costs", () => {
    // Rev 2 modelled only the reimbursement side. This is the one-directional
    // error: the driver pays the lumper whether or not anyone pays them back.
    const noReimbursement = ok(load({ lumperCost_cents: 12_000, detentionTermsKnown: true }));
    expect(noReimbursement.atRiskAccessorialRevenue_cents).toBe(0);
    expect(noReimbursement.trueEstimatedNet_cents).toBe(25725);
    expect(noReimbursement.assumptions.lumperBasis).toMatch(/charged independently/);
  });
});

describe("[R3-3] membership is exclusive and total, and 'reimbursables' is not a category", () => {
  it("every line is classified exactly once, and the classification is reported per line", () => {
    const r = ok(
      load({
        lines: [
          {
            id: "linehaul",
            bucket: "linehaul",
            amount_cents: 100_000,
            settlementState: "confirmed",
            reliability: "formula",
          },
          {
            id: "fuelSurcharge",
            bucket: "passThrough",
            amount_cents: 20_000,
            settlementState: "unconfirmed",
            reliability: "formula",
          },
          {
            id: "lumperReimbursement",
            bucket: "passThrough",
            amount_cents: 5_000,
            settlementState: "confirmed",
            reliability: "claim",
          },
          {
            id: "detention",
            bucket: "otherAccessorial",
            amount_cents: 7_000,
            settlementState: "collected",
            reliability: "claim",
          },
        ],
      }),
    );
    expect(r.classifiedRevenueLines.map((l) => [l.id, l.classification])).toEqual([
      ["linehaul", "reliable"],
      ["fuelSurcharge", "unconfirmed"],
      ["lumperReimbursement", "atRisk"],
      ["detention", "atRisk"],
    ]);
    expect(r.reliableRevenue_cents).toBe(100000);
    expect(r.atRiskAccessorialRevenue_cents).toBe(12000);
    expect(r.unconfirmedRevenue_cents).toBe(20000);
    expect(r.grossRevenue_cents).toBe(132000);
  });

  it("[R3-1] collected money leaves 'unconfirmed' for good — 6E owns that state, 3B only reads it", () => {
    const collected = ok(
      load({
        lines: [
          {
            id: "linehaul",
            bucket: "linehaul",
            amount_cents: 200_000,
            settlementState: "collected",
            reliability: "formula",
          },
        ],
      }),
    );
    expect(collected.reliableRevenue_cents).toBe(200000);
    expect(collected.unconfirmedRevenue_cents).toBe(0);
  });

  it("a missing settlementState is NEEDS_INPUT NAMING THE LINE, never a default", () => {
    const result = calculateTrueNet({
      ...load(),
      revenueLines: [
        {
          id: "fuelSurcharge",
          bucket: "passThrough",
          amount_cents: 30_000,
          reliability: "formula",
        } as unknown as RevenueLine,
      ],
    });
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    expect(result.missing).toEqual(["revenueLines[fuelSurcharge].settlementState"]);
  });

  it("a missing reliability is NEEDS_INPUT naming the line — it is declared, never inferred", () => {
    const result = calculateTrueNet({
      ...load(),
      revenueLines: [
        {
          id: "stopPay",
          bucket: "otherAccessorial",
          amount_cents: 5_000,
          settlementState: "confirmed",
        } as unknown as RevenueLine,
      ],
    });
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    expect(result.missing).toEqual(["revenueLines[stopPay].reliability"]);
  });

  it("a settlement state outside the union is a broken caller and throws", () => {
    expect(() =>
      calculateTrueNet({
        ...load(),
        revenueLines: [
          {
            id: "linehaul",
            bucket: "linehaul",
            amount_cents: 1000,
            settlementState: "probably" as SettlementState,
            reliability: "formula",
          },
        ],
      }),
    ).toThrow(/settlementState must be one of/);
  });

  it("a bucket outside the union — say 'reimbursables' — is a broken caller and throws", () => {
    expect(() =>
      calculateTrueNet({
        ...load(),
        revenueLines: [
          {
            id: "lumperReimbursement",
            bucket: "reimbursables" as RevenueBucket,
            amount_cents: 1000,
            settlementState: "confirmed",
            reliability: "claim",
          },
        ],
      }),
    ).toThrow(/bucket must be one of/);
  });

  it("duplicate line ids throw — a name that means two things is how a dollar gets counted twice", () => {
    expect(() =>
      calculateTrueNet({
        ...load(),
        revenueLines: [
          {
            id: "fuelSurcharge",
            bucket: "passThrough",
            amount_cents: 1000,
            settlementState: "confirmed",
            reliability: "formula",
          },
          {
            id: "fuelSurcharge",
            bucket: "passThrough",
            amount_cents: 2000,
            settlementState: "confirmed",
            reliability: "formula",
          },
        ],
      }),
    ).toThrow(/duplicate id/);
  });

  it("an empty or absent line list is NEEDS_INPUT — a load nobody entered is not a zero-revenue load", () => {
    for (const lines of [[], undefined]) {
      const result = calculateTrueNet({ ...load(), revenueLines: lines });
      expect(result.status).toBe("NEEDS_INPUT");
      if (result.status !== "NEEDS_INPUT") continue;
      expect(result.missing).toContain("revenueLines");
    }
  });
});

// ---------------------------------------------------------------------------
// R3-4 — allCosts, the sum Rev 2 named and never wrote
// ---------------------------------------------------------------------------

describe("[R3-4] allCosts — thirteen named lines, and the two that were entirely absent", () => {
  /*
   * A load that exercises every new cost line at once, on top of the base:
   *   DEF                 1500
   *   idle fuel           4000 milli-gal * 350c/gal / 1000 = 1400
   *   lumper cash        11000
   *   scale/permit/other  2000 (base)
   *   weight-dist/IFTA    3200
   *   factoring   gross 230000 * 300bp = 6900
   *   cost 192275 + 1500 + 1400 + 11000 + 3200 + 6900 = 216275
   *   net 230000 - 216275 = 13725 ; /day 13725*1440/2880 = 6862.5 -> 6863
   */
  const loaded = load({
    def_cents: 1500,
    idleFuelGallons_milli: 4000,
    lumperCost_cents: 11_000,
    weightDistanceAndIfta_cents: 3200,
    factoringBase: "gross",
    factoringOrQuickPay_bp: 300,
    detentionTermsKnown: true,
  });

  it("charges every named line and sums them exactly", () => {
    expect(ok(loaded)).toMatchObject({
      def_cents: 1500,
      idleFuelCost_cents: 1400,
      lumperCost_cents: 11000,
      scalePermitOtherCash_cents: 2000,
      weightDistanceAndIfta_cents: 3200,
      factoringOrQuickPay_cents: 6900,
      allCosts_cents: 216275,
      trueEstimatedNet_cents: 13725,
      netPerAvailableDay_cents: 6863,
      verdict: "negotiate",
    });
  });

  it("names what the number is and what overhead/day must exclude", () => {
    const a = ok(loaded).assumptions;
    expect(a.allCostsBasis).toMatch(/fuel \+ DEF \+ idle fuel \+ tolls \+ lumper cash/);
    expect(a.overheadInclusionBasis).toMatch(/EXCLUDING truck note, trailer note, lease escrow/);
    expect(a.netDefinition).toMatch(/before allocated fixed costs/);
  });

  it("[R3-7] factoring on gross vs on linehaul-less-dispatch are different contracts, never a default", () => {
    // gross 230000 * 300bp = 6900
    expect(
      ok(load({ factoringBase: "gross", factoringOrQuickPay_bp: 300 })).factoringOrQuickPay_cents,
    ).toBe(6900);
    // linehaul 200000 less a 1000bp haircut (20000) = 180000 * 300bp = 5400
    expect(
      ok(
        load({
          factoringBase: "linehaul_less_dispatch",
          factoringOrQuickPay_bp: 300,
          brokerOrDispatchHaircut_bp: 1000,
        }),
      ).factoringOrQuickPay_cents,
    ).toBe(5400);
    // none means ZERO and the configured bp is ignored and echoed, not applied.
    const none = ok(load({ factoringBase: "none", factoringOrQuickPay_bp: 300 }));
    expect(none.factoringOrQuickPay_cents).toBe(0);
    expect(none.assumptions.factoringBasis).toMatch(/300bp ignored/);
  });

  it("[R3-7] a missing factoring base is NEEDS_INPUT — both shapes exist in the wild", () => {
    const { factoringBase: _omitted, ...rest } = load();
    const result = calculateTrueNet(rest);
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    expect(result.missing).toEqual(["factoringBase"]);
  });

  it("idle fuel is priced at the same card-discounted rate and is invisible to miles/mpg", () => {
    // 12345 milli-gal * 350c / 1000 = 4320.75 -> 4321
    const r = ok(load({ idleFuelGallons_milli: 12_345 }));
    expect(r.idleFuelCost_cents).toBe(4321);
    // the road-fuel figure is untouched — these gallons are not miles
    expect(r.fuelCost_cents).toBe(74375);
  });
});

// ---------------------------------------------------------------------------
// R3-6 — the overhead allocation floor
// ---------------------------------------------------------------------------

describe("[R3-6] overhead is allocated by elapsed time, floored at one half-day", () => {
  it("a two-hour yard move carries half a day of overhead, not two hours of it", () => {
    // 120 min elapsed, floored to 720 -> 20000*720/1440 = 10000c, not 20000*120/1440 = 1667c
    const r = ok(load({ tripMinutes: 120 }));
    expect(r.overhead_cents).toBe(10000);
    expect(r.assumptions.overheadBasis).toMatch(/floored at 720 min, the default half-day/);
  });

  it("a trip longer than the floor is allocated on its real elapsed time", () => {
    expect(ok(load({ tripMinutes: 2880 })).overhead_cents).toBe(40000);
    expect(ok(load({ tripMinutes: 1440 })).overhead_cents).toBe(20000);
  });

  it("exactly at the floor, the floor changes nothing", () => {
    expect(ok(load({ tripMinutes: 720 })).overhead_cents).toBe(10000);
  });

  it("the floor is overridable per carrier and says so — never a hidden constant", () => {
    // floor overridden to 0: pure elapsed time, 20000*120/1440 = 1666.67 -> 1667
    const r = ok(load({ tripMinutes: 120, overheadFloorMinutes: 0 }));
    expect(r.overhead_cents).toBe(1667);
    expect(r.assumptions.overheadBasis).toMatch(/floored at 0 min, carrier override/);
    // and overridden upward to a full day
    expect(ok(load({ tripMinutes: 120, overheadFloorMinutes: 1440 })).overhead_cents).toBe(20000);
  });

  it("the floor allocates a COST — it never claims the trip took longer than it did", () => {
    // net/day still divides by the REAL 120 minutes
    const r = ok(load({ tripMinutes: 120 }));
    // net = 230000 - (192275 - 40000 + 10000) = 230000 - 162275 = 67725
    expect(r.trueEstimatedNet_cents).toBe(67725);
    // 67725*1440/120 = 812700
    expect(r.netPerAvailableDay_cents).toBe(812700);
  });

  it("a negative or fractional floor is a broken caller and throws", () => {
    for (const bad of [-1, 12.5, Number.NaN]) {
      expect(() => calculateTrueNet(load({ overheadFloorMinutes: bad }))).toThrow(TrueNetError);
    }
  });
});

// ---------------------------------------------------------------------------
// R3-9 — detention exposure: two labelled lines, both outside the net
// ---------------------------------------------------------------------------

describe("[R3-9] detention exposure — no dollar without hours", () => {
  it("hours unknown: BOTH exposure lines are NEEDS_INPUT and no dollar is shown", () => {
    const r = ok(load());
    expect(r.waitCost_cents).toBe("NEEDS_INPUT");
    expect(r.counterfactualDetention_cents).toBe("NEEDS_INPUT");
    expect(r.missingFacts).toContain("detentionHours");
    expect(r.assumptions.detentionExposureBasis).toMatch(/NO dollar is shown/);
  });

  it("hours known, terms absent: two separately labelled lines, both outside the net", () => {
    /*
     *   detention 2.500 h = 2500 milli ; collect rate 5000c/hr
     *   idle fuel 4000 milli-gal * 350 / 1000 = 1400c
     *   detentionMinutes = 2500*60/1000 = 150 ; overhead share 20000*150/1440 = 2083.3 -> 2083
     *   waitCost = 1400 + 2083 = 3483
     *   counterfactual = 2500 * 5000 / 1000 = 12500
     */
    const r = ok(
      load({
        idleFuelGallons_milli: 4000,
        detentionHours_milli: 2500,
        detentionCollectRate_cents_per_hour: 5000,
      }),
    );
    expect(r.waitCost_cents).toBe(3483);
    expect(r.counterfactualDetention_cents).toBe(12500);

    // Neither enters the net or the verdict: the same load without the detention
    // inputs prices identically.
    const without = ok(load({ idleFuelGallons_milli: 4000 }));
    expect(r.trueEstimatedNet_cents).toBe(without.trueEstimatedNet_cents);
    expect(r.verdict).toBe(without.verdict);
    expect(r.grossRevenue_cents).toBe(without.grossRevenue_cents);
  });

  it("the wait cost NAMES money already inside allCosts — it is not charged twice", () => {
    const r = ok(
      load({
        idleFuelGallons_milli: 4000,
        detentionHours_milli: 2500,
        detentionCollectRate_cents_per_hour: 5000,
      }),
    );
    // allCosts is base + idle fuel only; the wait cost added nothing to it.
    expect(r.allCosts_cents).toBe(192275 + 1400);
    expect(r.assumptions.detentionExposureBasis).toMatch(/named here rather than charged twice/);
  });

  it("hours known but no collect rate configured: the counterfactual stays NEEDS_INPUT", () => {
    const r = ok(load({ detentionHours_milli: 2500 }));
    expect(r.waitCost_cents).toBe(0 + 2083);
    expect(r.counterfactualDetention_cents).toBe("NEEDS_INPUT");
    expect(r.missingFacts).toContain("detentionCollectRate_cents_per_hour");
  });

  it("a confirmed zero hours is a real answer and produces zeroes, not NEEDS_INPUT", () => {
    const r = ok(load({ detentionHours_milli: 0, detentionCollectRate_cents_per_hour: 5000 }));
    expect(r.waitCost_cents).toBe(0);
    expect(r.counterfactualDetention_cents).toBe(0);
    expect(r.missingFacts).not.toContain("detentionHours");
  });

  it("no probability is invented anywhere — negative or fractional hours throw", () => {
    for (const bad of [-1, 12.5, Number.NaN]) {
      expect(() => calculateTrueNet(load({ detentionHours_milli: bad }))).toThrow(TrueNetError);
    }
  });
});

describe("detention — decision 3, never estimated into the net", () => {
  it("contributes exactly 0 cents and is surfaced as a flag when terms are unknown", () => {
    const unknown = ok(load());
    const known = ok(
      load({
        detentionTermsKnown: true,
        detentionHours_milli: 0,
        detentionCollectRate_cents_per_hour: 5000,
      }),
    );

    expect(unknown.trueEstimatedNet_cents).toBe(known.trueEstimatedNet_cents);
    expect(unknown.riskFlags).toContain(
      "Detention terms/hours unknown — not included in estimated net.",
    );
    expect(unknown.missingFacts).toEqual(["detentionHours", "detentionTermsKnown"]);
    expect(known.riskFlags).toEqual([]);
    expect(known.missingFacts).toEqual([]);
    expect(known.assumptions.confidence).toBe("All inputs confirmed.");
  });

  it("says so in the assumptions rather than leaving the driver to infer it", () => {
    expect(ok(load()).assumptions.detentionBasis).toMatch(/never estimated/);
  });
});

describe("fail closed — NEEDS_INPUT names the field, never a default", () => {
  it("reports missing revenue lines", () => {
    const { revenueLines: _omitted, ...rest } = load();
    const result = calculateTrueNet(rest);
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    expect(result.missing).toContain("revenueLines");
    expect(result.calcVersion).toBe(CALC_VERSION);
  });

  it("treats a zero where a positive is required as missing, not as a value", () => {
    const result = calculateTrueNet(load({ mpgLoaded_milli: 0 }));
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    expect(result.missing).toContain("mpgLoaded_milli");
  });

  it("reports a missing driver pay model", () => {
    const { driverPay: _omitted, ...rest } = load();
    const result = calculateTrueNet(rest);
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    expect(result.missing).toContain("driverPay");
  });

  it("lists every missing field at once rather than one per call", () => {
    const result = calculateTrueNet({ loadedMiles: 1000 });
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    expect(result.missing.length).toBeGreaterThan(5);
    expect(result.missing).toContain("revenueLines");
    expect(result.missing).toContain("driverPay");
  });
});

describe("guards — a broken input throws instead of producing a dollar figure", () => {
  it("throws on NaN", () => {
    expect(() => calculateTrueNet(load({ tolls_cents: Number.NaN }))).toThrow(TrueNetError);
  });

  it("throws on Infinity", () => {
    expect(() => calculateTrueNet(load({ tolls_cents: Number.POSITIVE_INFINITY }))).toThrow(
      /not finite/,
    );
  });

  it("throws on a fractional cent — the money path is integers only", () => {
    expect(() => calculateTrueNet(load({ tolls_cents: 1000.5 }))).toThrow(/must be an integer/);
  });

  it("throws on a fractional or negative cent inside a revenue line too", () => {
    expect(() => calculateTrueNet(load({ linehaul: 1000.5 }))).toThrow(/must be an integer/);
    expect(() => calculateTrueNet(load({ linehaul: -1 }))).toThrow(TrueNetError);
  });

  it("throws on negative cost input", () => {
    expect(() => calculateTrueNet(load({ tolls_cents: -1 }))).toThrow(/must not be negative/);
  });

  it("throws on a load with no distance at all", () => {
    expect(() =>
      calculateTrueNet(load({ loadedMiles: 0, deadheadMiles: 0, repositionMiles: 0 })),
    ).toThrow(/no distance/);
  });
});

/**
 * Property tests.
 *
 * The generator is a seeded LCG, not `Math.random()`. A money calculator whose
 * test suite is nondeterministic can go red in CI on a case nobody can
 * reproduce, so the sequence is fixed and a failure is always replayable.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const BUCKET_POOL: readonly RevenueBucket[] = ["linehaul", "passThrough", "otherAccessorial"];
const STATE_POOL: readonly SettlementState[] = ["unconfirmed", "confirmed", "collected"];
const RELIABILITY_POOL: readonly Reliability[] = ["formula", "claim"];
const FACTORING_POOL: readonly FactoringBase[] = ["none", "gross", "linehaul_less_dispatch"];

function randomLoad(next: () => number): TrueNetInput {
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const payRoll = next();
  const driverPay: TrueNetInput["driverPay"] =
    payRoll < 0.34
      ? { type: "none" }
      : payRoll < 0.67
        ? { type: "percent", percent_bp: int(0, 4000) }
        : { type: "perMile", rate_cents_per_mile: int(0, 90) };

  /*
   * Every generated load carries ONE settled, formula linehaul line with a known
   * id, so the monotonicity and fee-base properties below have a well-defined
   * line to bump, plus up to three randomly shaped extras that exercise every
   * bucket / settlement state / reliability combination.
   */
  const revenueLines: RevenueLine[] = [
    {
      id: "linehaul",
      bucket: "linehaul",
      amount_cents: int(0, 500_000),
      settlementState: "confirmed",
      reliability: "formula",
    },
  ];
  const extras = int(0, 3);
  for (let n = 0; n < extras; n += 1) {
    revenueLines.push({
      id: `extra${n}`,
      bucket: BUCKET_POOL[int(0, 2)]!,
      amount_cents: int(0, 100_000),
      settlementState: STATE_POOL[int(0, 2)]!,
      reliability: RELIABILITY_POOL[int(0, 1)]!,
    });
  }

  return {
    revenueLines,
    loadedMiles: int(1, 2500),
    deadheadMiles: int(0, 400),
    repositionMiles: int(0, 400),
    mpgLoaded_milli: int(3000, 9000),
    mpgEmpty_milli: int(3000, 12000),
    regionalDieselPrice_cents_per_gal: int(250, 650),
    fuelDiscount_cents_per_gal: int(0, 120),
    def_cents: int(0, 5000),
    idleFuelGallons_milli: int(0, 30_000),
    tolls_cents: int(0, 40_000),
    lumperCost_cents: int(0, 25_000),
    scalePermitOtherCash_cents: int(0, 30_000),
    maintenanceReserve_cents_per_mile: int(0, 40),
    tireReserve_cents_per_mile: int(0, 15),
    weightDistanceAndIfta_cents: int(0, 20_000),
    tripMinutes: int(60, 10_080),
    // R3-8: a zero overhead is a MISSING FACT, so the generator never produces one.
    overhead_cents_per_day: int(1, 60_000),
    driverPay,
    brokerOrDispatchHaircut_bp: int(0, 2500),
    settlementMode: (["self_dispatch", "third_party", "in_house_percent"] as const)[int(0, 2)]!,
    factoringBase: FACTORING_POOL[int(0, 2)]!,
    factoringOrQuickPay_bp: int(0, 500),
    dieselPriceSnapshotId: `gen:${int(1, 999_999)}`,
    breakEven_cents_per_mile: int(80, 300),
    target_cents_per_mile: int(150, 450),
  };
}

/** Returns a copy of `input` with the named line's amount raised by `delta`. */
function bumpLine(input: TrueNetInput, id: string, delta: number): TrueNetInput {
  return {
    ...input,
    revenueLines: input.revenueLines.map((l) =>
      l.id === id ? { ...l, amount_cents: l.amount_cents + delta } : l,
    ),
  };
}

/**
 * The 500 generated loads, built LAZILY on first use rather than in the describe
 * body.
 *
 * This is not a style preference. `calculateTrueNet` throws a TrueNetError when
 * a revenue partition stops being exhaustive (R3-3), and a throw in a describe
 * body aborts COLLECTION — the whole file reports "0 tests" and names nothing.
 * Built lazily, the same throw fails the specific property that caught it and
 * says which one. Found while verifying these gates against planted positives.
 */
let memoisedCases: TrueNetOk[] | undefined;
function generatedCases(): TrueNetOk[] {
  if (memoisedCases === undefined) {
    const built: TrueNetOk[] = [];
    const next = lcg(0x3b_10_09);
    for (let n = 0; n < 500; n++) built.push(ok(randomLoad(next)));
    memoisedCases = built;
  }
  return memoisedCases;
}

describe("properties — hold across 500 generated loads", () => {
  const cases = { [Symbol.iterator]: () => generatedCases()[Symbol.iterator]() };

  // T15 is also asserted inside ok() on every result this file produces; these
  // two restate it where a reader looks for it.
  it("[T15] the three BUCKETS sum to grossRevenue_cents — no double count, no line lost", () => {
    for (const r of cases) {
      expect(
        r.linehaulRevenue_cents + r.passThroughRevenue_cents + r.otherAccessorialRevenue_cents,
      ).toBe(r.grossRevenue_cents);
      // and each bucket is exactly the sum of the lines that declared it
      for (const bucket of BUCKET_POOL) {
        const expected = r.classifiedRevenueLines
          .filter((l) => l.bucket === bucket)
          .reduce((t, l) => t + l.amount_cents, 0);
        const actual =
          bucket === "linehaul"
            ? r.linehaulRevenue_cents
            : bucket === "passThrough"
              ? r.passThroughRevenue_cents
              : r.otherAccessorialRevenue_cents;
        expect(actual).toBe(expected);
      }
    }
  });

  it("[R3-1/R3-3] the three CLASSIFICATIONS also sum to gross, and every line has exactly one", () => {
    for (const r of cases) {
      expect(
        r.reliableRevenue_cents + r.atRiskAccessorialRevenue_cents + r.unconfirmedRevenue_cents,
      ).toBe(r.grossRevenue_cents);
      expect(r.classifiedRevenueLines.length).toBe(r.input.revenueLines.length);
      for (const l of r.classifiedRevenueLines) {
        expect(["reliable", "atRisk", "unconfirmed"]).toContain(l.classification);
      }
    }
  });

  it("[R3-2] reliable revenue is exactly the settled formula lines in linehaul and pass-through", () => {
    for (const r of cases) {
      const expected = r.classifiedRevenueLines
        .filter(
          (l) =>
            (l.settlementState === "confirmed" || l.settlementState === "collected") &&
            l.reliability === "formula" &&
            (l.bucket === "linehaul" || l.bucket === "passThrough"),
        )
        .reduce((t, l) => t + l.amount_cents, 0);
      expect(r.reliableRevenue_cents).toBe(expected);
    }
  });

  it("net is exactly RELIABLE revenue minus allCosts — at-risk and unconfirmed never enter it", () => {
    for (const r of cases) {
      expect(r.trueEstimatedNet_cents).toBe(r.reliableRevenue_cents - r.allCosts_cents);
      expect(r.upsideIfAllAccessorialsPay_cents).toBe(
        r.trueEstimatedNet_cents + r.atRiskAccessorialRevenue_cents,
      );
    }
  });

  it("adding confirmed at-risk accessorials never moves the verdict or the net (absent a gross-based factoring fee)", () => {
    /*
     * The Rev 2 invariant, restated for Rev 3. It is exact wherever the carrier
     * does not factor on GROSS. Where they do, the larger invoice carries a
     * larger factoring fee and the net drops by EXACTLY that fee and nothing
     * else — so the verdict can only get worse, never better.
     *
     * TODO(Cowork): whether the factoring fee should be charged on at-risk and
     * unconfirmed revenue that may never be collected is not ruled in R3-7.
     * `gross` is the spec's literal word and is what is built; the alternative
     * reading (fee on reliable only) understates a real cost. Flagged, not
     * decided here.
     */
    const rank = { skip: 0, negotiate: 1, take: 2 } as const;
    const gen = lcg(20260911);
    for (let n = 0; n < 500; n += 1) {
      const base = randomLoad(gen);
      const original = ok(base);
      const extra = 1 + Math.floor(gen() * 50000);
      const bumped = ok({
        ...base,
        revenueLines: [
          ...base.revenueLines,
          {
            id: "addedDetention",
            bucket: "otherAccessorial",
            amount_cents: extra,
            settlementState: "confirmed",
            reliability: "claim",
          },
        ],
        detentionTermsKnown: true,
      });

      expect(bumped.atRiskAccessorialRevenue_cents).toBe(
        original.atRiskAccessorialRevenue_cents + extra,
      );
      expect(bumped.grossRevenue_cents).toBe(original.grossRevenue_cents + extra);
      expect(bumped.reliableRevenue_cents).toBe(original.reliableRevenue_cents);

      const feeDelta = bumped.factoringOrQuickPay_cents - original.factoringOrQuickPay_cents;
      expect(feeDelta).toBeGreaterThanOrEqual(0);
      if (base.factoringBase !== "gross") expect(feeDelta).toBe(0);
      expect(bumped.trueEstimatedNet_cents).toBe(original.trueEstimatedNet_cents - feeDelta);
      if (feeDelta === 0) {
        expect(bumped.verdict).toBe(original.verdict);
      } else {
        expect(rank[bumped.verdict]).toBeLessThanOrEqual(rank[original.verdict]);
      }
    }
  });

  it("[R3-1] unconfirmed revenue raises gross, never the net or the verdict", () => {
    const gen = lcg(0x3b_4_13);
    for (let n = 0; n < 300; n += 1) {
      const base = randomLoad(gen);
      // deliberately NOT gross-factored, so the only possible effect is the one
      // being tested for
      const original = ok({ ...base, factoringBase: "none" });
      const extra = 1 + Math.floor(gen() * 50000);
      const bumped = ok({
        ...base,
        factoringBase: "none",
        revenueLines: [
          ...base.revenueLines,
          {
            id: "tbdFuelSurcharge",
            bucket: "passThrough",
            amount_cents: extra,
            settlementState: "unconfirmed",
            reliability: "formula",
          },
        ],
      });
      expect(bumped.grossRevenue_cents).toBe(original.grossRevenue_cents + extra);
      expect(bumped.unconfirmedRevenue_cents).toBe(original.unconfirmedRevenue_cents + extra);
      expect(bumped.reliableRevenue_cents).toBe(original.reliableRevenue_cents);
      expect(bumped.trueEstimatedNet_cents).toBe(original.trueEstimatedNet_cents);
      expect(bumped.verdict).toBe(original.verdict);
      expect(bumped.missingFacts).toContain("tbdFuelSurcharge");
    }
  });

  it("[R3-9] the detention exposure lines never touch the net or the verdict", () => {
    const gen = lcg(0x3b_4_9);
    for (let n = 0; n < 300; n += 1) {
      const base = randomLoad(gen);
      const without = ok(base);
      const withExposure = ok({
        ...base,
        detentionHours_milli: Math.floor(gen() * 12_000),
        detentionCollectRate_cents_per_hour: 1 + Math.floor(gen() * 10_000),
      });
      expect(withExposure.trueEstimatedNet_cents).toBe(without.trueEstimatedNet_cents);
      expect(withExposure.allCosts_cents).toBe(without.allCosts_cents);
      expect(withExposure.verdict).toBe(without.verdict);
      expect(typeof withExposure.waitCost_cents).toBe("number");
      expect(typeof withExposure.counterfactualDetention_cents).toBe("number");
    }
  });

  it("[R3-4] allCosts is exactly the sum of its thirteen named lines", () => {
    for (const r of cases) {
      expect(r.allCosts_cents).toBe(
        r.fuelCost_cents +
          r.def_cents +
          r.idleFuelCost_cents +
          r.tolls_cents +
          r.lumperCost_cents +
          r.scalePermitOtherCash_cents +
          r.maintenanceReserve_cents +
          r.tireReserve_cents +
          r.overhead_cents +
          r.weightDistanceAndIfta_cents +
          r.factoringOrQuickPay_cents +
          r.driverPay_cents +
          r.brokerOrDispatchHaircut_cents,
      );
    }
  });

  it("every money figure is an integer number of cents", () => {
    const moneyFields = [
      "grossRevenue_cents",
      "reliableRevenue_cents",
      "atRiskAccessorialRevenue_cents",
      "unconfirmedRevenue_cents",
      "upsideIfAllAccessorialsPay_cents",
      "fuelCost_cents",
      "def_cents",
      "idleFuelCost_cents",
      "tolls_cents",
      "lumperCost_cents",
      "scalePermitOtherCash_cents",
      "maintenanceReserve_cents",
      "tireReserve_cents",
      "overhead_cents",
      "weightDistanceAndIfta_cents",
      "factoringOrQuickPay_cents",
      "driverPay_cents",
      "brokerOrDispatchHaircut_cents",
      "allCosts_cents",
      "trueEstimatedNet_cents",
      "allInRpm_millicents_per_mile",
      "netPerAvailableDay_cents",
      "breakEvenRate_cents",
      "floorRate_cents",
      "recommendedBid_cents",
    ] as const;
    for (const r of cases) {
      for (const f of moneyFields) expect(Number.isSafeInteger(r[f])).toBe(true);
    }
  });

  it("is deterministic — the same input always produces the same result", () => {
    const replay = lcg(0x3b_10_09);
    for (const previous of cases) {
      expect(calculateTrueNet(randomLoad(replay))).toEqual(previous);
    }
  });

  it("percent driver pay and the haircut never respond to non-linehaul revenue", () => {
    const replay = lcg(0x3b_10_09);
    for (let n = 0; n < 500; n++) {
      const input = randomLoad(replay);
      if (input.driverPay.type !== "percent") continue;
      const original = ok(input);
      const bumped = ok({
        ...input,
        revenueLines: [
          ...input.revenueLines,
          {
            id: "addedPassThrough",
            bucket: "passThrough",
            amount_cents: 25_000,
            settlementState: "confirmed",
            reliability: "formula",
          },
          {
            id: "addedAccessorial",
            bucket: "otherAccessorial",
            amount_cents: 25_000,
            settlementState: "confirmed",
            reliability: "claim",
          },
        ],
      });
      expect(bumped.driverPay_cents).toBe(original.driverPay_cents);
      expect(bumped.brokerOrDispatchHaircut_cents).toBe(original.brokerOrDispatchHaircut_cents);
    }
  });

  it("more linehaul revenue never makes the verdict worse", () => {
    const rank = { skip: 0, negotiate: 1, take: 2 } as const;
    const replay = lcg(0x3b_10_09);
    for (let n = 0; n < 500; n++) {
      const input = randomLoad(replay);
      const original = ok(input);
      const richer = ok(bumpLine(input, "linehaul", 100_000));
      expect(rank[richer.verdict]).toBeGreaterThanOrEqual(rank[original.verdict]);
    }
  });

  it("stamps the calculator version, the fuel snapshot id and the full input set on every result", () => {
    for (const r of cases) {
      expect(r.calcVersion).toBe(CALC_VERSION);
      expect(r.dieselPriceSnapshotId).toBe(r.input.dieselPriceSnapshotId); // 3B-R3, N-5
      expect(r.input.revenueLines).toEqual(
        r.classifiedRevenueLines.map(({ classification: _c, ...line }) => line),
      );
    }
  });

  it("[3B-R3, N-3] the haircut is zero under self_dispatch and the configured bp otherwise", () => {
    for (const r of cases) {
      const expected =
        r.input.settlementMode === "self_dispatch"
          ? 0
          : Math.trunc(
              (r.linehaulRevenue_cents * r.input.brokerOrDispatchHaircut_bp + 5000) / 10_000,
            );
      expect(r.brokerOrDispatchHaircut_cents).toBe(expected);
    }
  });

  it("always explains itself — a number with no derivation is not shippable", () => {
    for (const r of cases) {
      expect(r.reasons.length).toBeGreaterThan(0);
      expect(r.assumptions.calculatedFrom).toMatch(/total miles/);
      expect(r.assumptions.confidence.length).toBeGreaterThan(0);
      // Rev 3: the line-level audit trail is on every result
      expect(r.assumptions.revenueLineBasis.length).toBeGreaterThan(0);
      expect(r.assumptions.bucketMembershipBasis).toMatch(/= gross/);
      expect(r.assumptions.settlementStateBasis).toMatch(/= gross/);
    }
  });
});

// ---------------------------------------------------------------------------
// SPEC-3B Rev 2, F-3 — the rounding rule, asserted on values that actually land
// on the half-cent. NOTE on the spec's own example: 12345 x 0.25 = 3086.25, which
// rounds to 3086 under floor, half-up AND banker's — it cannot distinguish rules.
// It is kept below as written, and the case that CAN distinguish is added next
// to it: 12346 x 0.25 = 3086.5 -> 3087 half-up (floor and banker's give 3086).
// ---------------------------------------------------------------------------

describe("[Rev 2, F-3] rounding — half-up, away from zero, per multiply, never chained", () => {
  it("the spec's literal case: 12345 x 25% -> 3086 (not 3085)", () => {
    expect(ok(load({ linehaul: 12345 })).driverPay_cents).toBe(3086);
  });

  it("a TRUE half-cent: 12346 x 25% = 3086.5 -> 3087 (floor and banker's would say 3086)", () => {
    expect(ok(load({ linehaul: 12346 })).driverPay_cents).toBe(3087);
  });

  it("the haircut follows the same rule: 12350 x 5% = 617.5 -> 618", () => {
    expect(
      ok(load({ linehaul: 12350, brokerOrDispatchHaircut_bp: 500 })).brokerOrDispatchHaircut_cents,
    ).toBe(618);
  });

  it("each multiply is independent from linehaul — the haircut is never taken off a rounded pay subtotal", () => {
    // 12346: pay 25% -> 3087 (half-up) ; haircut 5% -> 617.3 -> 617, computed from 12346, not from 12346-3087.
    const r = ok(load({ linehaul: 12346, brokerOrDispatchHaircut_bp: 500 }));
    expect(r.driverPay_cents).toBe(3087);
    expect(r.brokerOrDispatchHaircut_cents).toBe(617);
    expect(r.assumptions.roundingBasis).toMatch(/half-up/);
  });
});

// ---------------------------------------------------------------------------
// SPEC-3B Rev 2, F-2 — the clock is reported, never priced, never in the verdict
// ---------------------------------------------------------------------------

describe("[Rev 2, F-2] clock — reported outputs only", () => {
  it("reports hours in thousandths and net per available hour when the minutes are known", () => {
    // base net 37725 ; 540 min = 9.000 h ; 37725*60/540 = 4191.67 -> 4192
    const r = ok(load({ clockMinutesConsumed: 540 }));
    expect(r.clockHoursConsumed_milli).toBe(9000);
    expect(r.netPerAvailableHour_cents).toBe(4192);
  });

  it("returns NEEDS_INPUT for both outputs when the minutes are unknown — never a default", () => {
    const r = ok(load());
    expect(r.clockHoursConsumed_milli).toBe("NEEDS_INPUT");
    expect(r.netPerAvailableHour_cents).toBe("NEEDS_INPUT");
    expect(r.assumptions.clockBasis).toMatch(/never defaulted/);
  });

  it("a zero or non-integer clock is treated as unknown, not as a division", () => {
    for (const bad of [0, -30, 12.5]) {
      expect(ok(load({ clockMinutesConsumed: bad })).netPerAvailableHour_cents).toBe("NEEDS_INPUT");
    }
  });

  it("the clock never changes the verdict or the net", () => {
    const without = ok(load());
    for (const minutes of [60, 540, 2880]) {
      const withClock = ok(load({ clockMinutesConsumed: minutes }));
      expect(withClock.verdict).toBe(without.verdict);
      expect(withClock.trueEstimatedNet_cents).toBe(without.trueEstimatedNet_cents);
    }
  });
});

describe("[3B-R3, N-1] the number is defined, in words, on every result", () => {
  it("names what the net IS and what it is NOT", () => {
    const a = ok(load()).assumptions;
    expect(a.netDefinition).toMatch(/contribution after trip cash costs/);
    expect(a.netDefinition).toMatch(/NOT take-home, NOT weekly profit, NOT after-tax/);
  });
});

describe("[3B-R3, N-2] deadhead attribution is stated on the result", () => {
  it("says which empty miles were charged and under what rule", () => {
    expect(ok(load()).assumptions.deadheadBasis).toMatch(
      /100 deadhead \+ 0 reposition miles charged as supplied/,
    );
  });
});

describe("[3B-R3, N-3] settlement mode — self-dispatch pays no dispatch fee", () => {
  it("G21 self_dispatch zeroes a configured 1000bp haircut — identical to G03", () => {
    const r = ok(
      load({
        passThrough: 100000,
        brokerOrDispatchHaircut_bp: 1000,
        settlementMode: "self_dispatch",
      }),
    );
    expect(r).toMatchObject({
      brokerOrDispatchHaircut_cents: 0,
      allCosts_cents: 192275,
      trueEstimatedNet_cents: 107725,
      netPerAvailableDay_cents: 53863,
      verdict: "take",
    });
    expect(r.assumptions.haircutBasis).toMatch(/self-dispatch pays no dispatch fee/);
  });

  it("third_party and in_house_percent both apply the haircut to linehaul only (G04 figure)", () => {
    for (const mode of ["third_party", "in_house_percent"] as const) {
      expect(
        ok(
          load({
            passThrough: 100000,
            brokerOrDispatchHaircut_bp: 1000,
            settlementMode: mode,
          }),
        ).brokerOrDispatchHaircut_cents,
      ).toBe(20000);
    }
  });

  it("fees are computed independently — the haircut is never taken off a driver-pay subtotal, in any mode", () => {
    for (const mode of ["third_party", "in_house_percent"] as const) {
      const r = ok(
        load({ linehaul: 12346, brokerOrDispatchHaircut_bp: 500, settlementMode: mode }),
      );
      expect(r.driverPay_cents).toBe(3087);
      expect(r.brokerOrDispatchHaircut_cents).toBe(617);
    }
  });

  it("a missing settlement mode is NEEDS_INPUT, never assumed", () => {
    const { settlementMode: _omitted, ...rest } = load();
    const result = calculateTrueNet(rest);
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status === "NEEDS_INPUT") expect(result.missing).toEqual(["settlementMode"]);
  });

  it("an unknown settlement mode is a broken caller and throws", () => {
    expect(() =>
      calculateTrueNet(load({ settlementMode: "handshake" as TrueNetInput["settlementMode"] })),
    ).toThrow(/settlementMode must be one of/);
  });
});

describe("[3B-R3, N-5] the fuel-price snapshot is pinned next to the calculator version", () => {
  it("stamps the id on the result and names it in the assumptions", () => {
    const r = ok(load({ dieselPriceSnapshotId: "eia:padd3:2026-09-08T00:00Z" }));
    expect(r.calcVersion).toBe("3B.4.0");
    expect(r.dieselPriceSnapshotId).toBe("eia:padd3:2026-09-08T00:00Z");
    expect(r.assumptions.dieselPriceSnapshot).toMatch(
      /400c\/gal from snapshot eia:padd3:2026-09-08T00:00Z/,
    );
  });

  it("a missing or empty snapshot id is NEEDS_INPUT — an unpinned price cannot be re-derived", () => {
    const { dieselPriceSnapshotId: _omit, ...rest } = load();
    const missing = calculateTrueNet(rest);
    expect(missing.status).toBe("NEEDS_INPUT");
    if (missing.status === "NEEDS_INPUT")
      expect(missing.missing).toEqual(["dieselPriceSnapshotId"]);
    const empty = calculateTrueNet(load({ dieselPriceSnapshotId: "" }));
    expect(empty.status).toBe("NEEDS_INPUT");
  });

  it("the id is opaque — it is never parsed, only echoed", () => {
    const r = ok(load({ dieselPriceSnapshotId: "manual:andrew:whatever 🚚" }));
    expect(r.dieselPriceSnapshotId).toBe("manual:andrew:whatever 🚚");
  });
});

describe("[3B-R3, F-2 amendment] the carrier's OWN hourly floor may turn a verdict to skip", () => {
  // base net 37725 ; 540 min -> 37725*60/540 = 4191.67 -> 4192c per available hour
  it("skips when net per available hour is below the configured floor", () => {
    const r = ok(load({ clockMinutesConsumed: 540, hourlyFloor_cents: 4500 }));
    expect(r.netPerAvailableHour_cents).toBe(4192);
    expect(r.verdict).toBe("skip");
    expect(r.reasons).toContainEqual(
      expect.stringMatching(/4192c\) is below your own hourly floor \(4500c\)/),
    );
    expect(r.assumptions.hourlyFloorBasis).toMatch(/turned to skip/);
    // the NET is untouched — the floor is a gate, not a cost
    expect(r.trueEstimatedNet_cents).toBe(37725);
  });

  it("leaves the verdict alone when the floor is cleared (exactly at the floor clears it)", () => {
    expect(ok(load({ clockMinutesConsumed: 540, hourlyFloor_cents: 4192 })).verdict).toBe(
      "negotiate",
    );
    expect(ok(load({ clockMinutesConsumed: 540, hourlyFloor_cents: 4000 })).verdict).toBe(
      "negotiate",
    );
  });

  it("does not run when no floor is set — no default, no guess", () => {
    const r = ok(load({ clockMinutesConsumed: 540 }));
    expect(r.verdict).toBe("negotiate");
    expect(r.assumptions.hourlyFloorBasis).toMatch(/no hourly floor configured/);
    expect(r.missingFacts).not.toContain("clockMinutesConsumed");
  });

  it("cannot run when the floor is set but the clock is unknown — flagged and listed as missing, verdict unchanged", () => {
    const r = ok(load({ hourlyFloor_cents: 4500 }));
    expect(r.verdict).toBe("negotiate");
    expect(r.netPerAvailableHour_cents).toBe("NEEDS_INPUT");
    expect(r.riskFlags).toContainEqual(
      expect.stringMatching(/floor of 4500c\/hr is set but the clock minutes are unknown/),
    );
    expect(r.missingFacts).toContain("clockMinutesConsumed");
    expect(r.assumptions.hourlyFloorBasis).toMatch(/gate NOT evaluated/);
  });

  it("a zero, negative or fractional floor is a broken caller and throws", () => {
    for (const bad of [0, -1, 12.5, Number.NaN]) {
      expect(() => calculateTrueNet(load({ hourlyFloor_cents: bad }))).toThrow(TrueNetError);
    }
  });

  it("the floor can only make a verdict WORSE, never better — across 200 generated loads", () => {
    const rank = { skip: 0, negotiate: 1, take: 2 } as const;
    const next = lcg(0x3b_03);
    for (let n = 0; n < 200; n += 1) {
      const base = randomLoad(next);
      const clock = 60 + Math.floor(next() * 600);
      const without = ok({ ...base, clockMinutesConsumed: clock });
      const withFloor = ok({
        ...base,
        clockMinutesConsumed: clock,
        hourlyFloor_cents: 1 + Math.floor(next() * 8000),
      });
      expect(rank[withFloor.verdict]).toBeLessThanOrEqual(rank[without.verdict]);
      expect(withFloor.trueEstimatedNet_cents).toBe(without.trueEstimatedNet_cents);
      if (withFloor.verdict !== without.verdict) {
        expect(withFloor.verdict).toBe("skip");
        expect(withFloor.netPerAvailableHour_cents).toBeLessThan(
          withFloor.input.hourlyFloor_cents as number,
        );
      }
    }
  });
});
