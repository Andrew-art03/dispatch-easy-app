import { describe, expect, it } from "vitest";

import {
  CALC_VERSION,
  TrueNetError,
  calculateTrueNet,
  type TrueNetInput,
  type TrueNetOk,
} from "../packages/domain/trueNet.ts";

/**
 * SPEC 3B gate: 20 golden loads to the cent, plus property tests.
 *
 * Every expected number below was derived by hand from the formulas in
 * SPEC-3B-TRUENET-CONTRACT.md and is written as a literal. None was copied out
 * of a run — a golden case that records whatever the code happened to print
 * pins the bug rather than the contract. The arithmetic is shown in the comment
 * above each case so a reviewer can check it without running anything.
 *
 * The base load, reused by most cases:
 *   revenue      linehaul 200000c, pass-through 30000c, other 0c  → gross 230000c
 *   distance     1000 loaded + 100 deadhead + 0 reposition        → 1100 total
 *   fuel         5.000 mpg loaded / 8.000 mpg empty, 400c posted less 50c → 350c effective
 *                loaded 1000*1000*350/5000 = 70000c
 *                empty   100*1000*350/8000 =  4375c              → 74375c
 *   reserves     15c/mi * 1100 = 16500c ; 4c/mi * 1100 = 4400c
 *   tolls 5000c ; known expenses 2000c
 *   overhead     20000c/day * 2880min / 1440 = 40000c
 *   driver pay   25% of LINEHAUL only = 50000c
 *   haircut      0bp = 0c
 *   trip cost    74375+5000+16500+4400+2000+40000+50000+0 = 192275c
 *   net          230000 - 192275 = 37725c
 *   thresholds   break-even 180c/mi -> 198000c ; target 220c/mi -> 242000c
 */
const BASE: TrueNetInput = {
  linehaulRevenue_cents: 200000,
  passThroughRevenue_cents: 30000,
  otherAccessorialRevenue_cents: 0,
  loadedMiles: 1000,
  deadheadMiles: 100,
  repositionMiles: 0,
  mpgLoaded_milli: 5000,
  mpgEmpty_milli: 8000,
  regionalDieselPrice_cents_per_gal: 400,
  fuelDiscount_cents_per_gal: 50,
  tolls_cents: 5000,
  maintenanceReserve_cents_per_mile: 15,
  tireReserve_cents_per_mile: 4,
  knownExpenses_cents: 2000,
  tripMinutes: 2880,
  overhead_cents_per_day: 20000,
  driverPay: { type: "percent", percent_bp: 2500 },
  brokerOrDispatchHaircut_bp: 0,
  breakEven_cents_per_mile: 180,
  target_cents_per_mile: 220,
};

function load(overrides: Partial<TrueNetInput> = {}): TrueNetInput {
  return { ...BASE, ...overrides };
}

/** Every golden case expects OK; this keeps the narrowing out of each one. */
function ok(input: Partial<TrueNetInput>): TrueNetOk {
  const result = calculateTrueNet(input);
  if (result.status !== "OK") {
    throw new Error(`expected OK, got NEEDS_INPUT missing [${result.missing.join(", ")}]`);
  }
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
      trueTripCost_cents: 192275,
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
    const r = ok(load({ otherAccessorialRevenue_cents: 15000, detentionTermsKnown: true }));
    expect(r).toMatchObject({
      grossRevenue_cents: 245000,
      reliableRevenue_cents: 230000,
      atRiskAccessorialRevenue_cents: 15000,
      upsideIfAllAccessorialsPay_cents: 52725,
      trueEstimatedNet_cents: 37725,
      netPerAvailableDay_cents: 18863,
      verdict: "negotiate",
    });
    // The same load with the detention removed reaches the identical verdict and net.
    const without = ok(load({ detentionTermsKnown: true }));
    expect(without.verdict).toBe(r.verdict);
    expect(without.trueEstimatedNet_cents).toBe(r.trueEstimatedNet_cents);
    expect(r.riskFlags).toContainEqual(expect.stringMatching(/15000c of confirmed accessorials is at risk/));
    expect(r.reasons).toContainEqual(expect.stringMatching(/not counted toward this verdict/));
  });

  // G03 percent pay is LINEHAUL ONLY: pass-through 30000 -> 100000 raises gross to 300000
  //     but driver pay stays 50000. cost unchanged 192275 ; net 107725
  //     107725*1440/2880 = 53862.5 -> 53863
  it("G03 pass-through revenue does not raise percent driver pay — take", () => {
    expect(ok(load({ passThroughRevenue_cents: 100000 }))).toMatchObject({
      grossRevenue_cents: 300000,
      driverPay_cents: 50000,
      trueTripCost_cents: 192275,
      trueEstimatedNet_cents: 107725,
      netPerAvailableDay_cents: 53863,
      verdict: "take",
    });
  });

  // G04 haircut is LINEHAUL ONLY: 1000bp of 200000 = 20000, not 10% of gross 300000.
  //     cost 192275+20000 = 212275 ; net 300000-212275 = 87725 ; /day 43862.5 -> 43863
  it("G04 haircut applies to linehaul only — take", () => {
    expect(
      ok(load({ passThroughRevenue_cents: 100000, brokerOrDispatchHaircut_bp: 1000 })),
    ).toMatchObject({
      brokerOrDispatchHaircut_cents: 20000,
      trueTripCost_cents: 212275,
      trueEstimatedNet_cents: 87725,
      netPerAvailableDay_cents: 43863,
      verdict: "take",
    });
  });

  // G05 fuel discount is dollars off: 100c off 400c -> 300c effective.
  //     loaded 1000*1000*300/5000 = 60000 ; empty 100*1000*300/8000 = 3750 ; fuel 63750
  //     cost 63750+5000+16500+4400+2000+40000+50000 = 181650 ; net 48350 ; /day 24175
  it("G05 larger per-gallon discount lowers fuel cost — negotiate", () => {
    expect(ok(load({ fuelDiscount_cents_per_gal: 100 }))).toMatchObject({
      effectiveDieselPrice_cents_per_gal: 300,
      fuelCost_cents: 63750,
      trueTripCost_cents: 181650,
      trueEstimatedNet_cents: 48350,
      netPerAvailableDay_cents: 24175,
      verdict: "negotiate",
    });
  });

  // G06 negative net forces skip regardless of thresholds.
  //     linehaul 50000 -> gross 50000 ; pay 12500 ; cost 74375+5000+16500+4400+2000+40000+12500 = 154775
  //     net -104775 ; /day -(104775*1440/2880 = 52387.5 -> 52388)
  it("G06 negative net — skip", () => {
    expect(
      ok(load({ linehaulRevenue_cents: 50000, passThroughRevenue_cents: 0 })),
    ).toMatchObject({
      grossRevenue_cents: 50000,
      driverPay_cents: 12500,
      trueTripCost_cents: 154775,
      trueEstimatedNet_cents: -104775,
      netPerAvailableDay_cents: -52388,
      verdict: "skip",
    });
  });

  // G07 positive net but below the carrier's break-even -> still skip.
  //     all costs stripped except fuel 74375 ; gross 190000 ; net 115625
  //     190000 < breakEvenRate 198000 ; /day 115625*1440/2880 = 57812.5 -> 57813
  it("G07 positive net but under break-even — skip", () => {
    expect(
      ok(
        load({
          linehaulRevenue_cents: 190000,
          passThroughRevenue_cents: 0,
          tolls_cents: 0,
          maintenanceReserve_cents_per_mile: 0,
          tireReserve_cents_per_mile: 0,
          knownExpenses_cents: 0,
          overhead_cents_per_day: 0,
          driverPay: { type: "none" },
        }),
      ),
    ).toMatchObject({
      grossRevenue_cents: 190000,
      trueTripCost_cents: 74375,
      trueEstimatedNet_cents: 115625,
      netPerAvailableDay_cents: 57813,
      breakEvenRate_cents: 198000,
      verdict: "skip",
    });
  });

  // G08 boundary: gross exactly equals the target -> take (inclusive).
  //     linehaul 242000 ; pay 25% = 60500 ; cost 74375+5000+16500+4400+2000+40000+60500 = 202775
  //     net 39225 ; rpm 242000*1000/1100 = 220000 ; /day 39225*1440/2880 = 19612.5 -> 19613
  it("G08 gross exactly at target — take", () => {
    expect(
      ok(load({ linehaulRevenue_cents: 242000, passThroughRevenue_cents: 0 })),
    ).toMatchObject({
      grossRevenue_cents: 242000,
      driverPay_cents: 60500,
      trueTripCost_cents: 202775,
      trueEstimatedNet_cents: 39225,
      allInRpm_millicents_per_mile: 220000,
      netPerAvailableDay_cents: 19613,
      verdict: "take",
    });
  });

  // G09 boundary: gross exactly equals break-even -> negotiate (inclusive).
  //     linehaul 198000 ; pay 49500 ; cost 74375+5000+16500+4400+2000+40000+49500 = 191775
  //     net 6225 ; rpm 180000 ; /day 6225*1440/2880 = 3112.5 -> 3113
  it("G09 gross exactly at break-even — negotiate", () => {
    expect(
      ok(load({ linehaulRevenue_cents: 198000, passThroughRevenue_cents: 0 })),
    ).toMatchObject({
      grossRevenue_cents: 198000,
      driverPay_cents: 49500,
      trueTripCost_cents: 191775,
      trueEstimatedNet_cents: 6225,
      allInRpm_millicents_per_mile: 180000,
      netPerAvailableDay_cents: 3113,
      verdict: "negotiate",
    });
  });

  // G10 per-mile driver pay applies to ALL miles: 60c * 1100 = 66000.
  //     cost 74375+5000+16500+4400+2000+40000+66000 = 208275 ; net 21725 ; /day 10862.5 -> 10863
  it("G10 per-mile driver pay covers loaded and empty miles — negotiate", () => {
    expect(
      ok(load({ driverPay: { type: "perMile", rate_cents_per_mile: 60 } })),
    ).toMatchObject({
      driverPay_cents: 66000,
      trueTripCost_cents: 208275,
      trueEstimatedNet_cents: 21725,
      netPerAvailableDay_cents: 10863,
      verdict: "negotiate",
    });
  });

  // G11 owner-operator taking no pay line: cost 192275-50000 = 142275 ; net 87725 ; /day 43863
  it("G11 no driver pay line — negotiate", () => {
    expect(ok(load({ driverPay: { type: "none" } }))).toMatchObject({
      driverPay_cents: 0,
      trueTripCost_cents: 142275,
      trueEstimatedNet_cents: 87725,
      netPerAvailableDay_cents: 43863,
      verdict: "negotiate",
    });
  });

  // G12 half-way rounding rounds away from zero in all three places at once:
  //     overhead   1*720/1440   = 0.5 -> 1
  //     driver pay 100*50/10000 = 0.5 -> 1
  //     haircut    100*50/10000 = 0.5 -> 1
  //     fuel 1*1000*10/1000 = 10 ; cost 10+1+1+1 = 13 ; net 100-13 = 87
  //     rpm 100*1000/1 = 100000 ; /day 87*1440/720 = 174
  it("G12 exact halves round away from zero — take", () => {
    expect(
      ok({
        linehaulRevenue_cents: 100,
        passThroughRevenue_cents: 0,
        otherAccessorialRevenue_cents: 0,
        loadedMiles: 1,
        deadheadMiles: 0,
        repositionMiles: 0,
        mpgLoaded_milli: 1000,
        mpgEmpty_milli: 1000,
        regionalDieselPrice_cents_per_gal: 10,
        fuelDiscount_cents_per_gal: 0,
        tolls_cents: 0,
        maintenanceReserve_cents_per_mile: 0,
        tireReserve_cents_per_mile: 0,
        knownExpenses_cents: 0,
        tripMinutes: 720,
        overhead_cents_per_day: 1,
        driverPay: { type: "percent", percent_bp: 50 },
        brokerOrDispatchHaircut_bp: 50,
        breakEven_cents_per_mile: 1,
        target_cents_per_mile: 2,
      }),
    ).toMatchObject({
      fuelCost_cents: 10,
      overhead_cents: 1,
      driverPay_cents: 1,
      brokerOrDispatchHaircut_cents: 1,
      trueTripCost_cents: 13,
      trueEstimatedNet_cents: 87,
      allInRpm_millicents_per_mile: 100000,
      netPerAvailableDay_cents: 174,
      verdict: "take",
    });
  });

  // G13 awkward numbers: linehaul 111111 -> pay 111111*2500/10000 = 27777.75 -> 27778
  //     gross 111111+22222+3333 = 136666
  //     cost 74375+5000+16500+4400+2000+40000+27778 = 170053
  //     [Rev 2] reliable 111111+22222 = 133333 ; net 133333-170053 = -36720 -> skip ; at-risk 3333
  //     upside -36720+3333 = -33387 (Rev 1's net). rpm stays gross-based: 136666000/1100 -> 124242
  //     /day -36720*1440/2880 = -18360 exactly
  it("G13 non-round inputs round once, at the end — skip", () => {
    expect(
      ok(
        load({
          linehaulRevenue_cents: 111111,
          passThroughRevenue_cents: 22222,
          otherAccessorialRevenue_cents: 3333,
        }),
      ),
    ).toMatchObject({
      grossRevenue_cents: 136666,
      reliableRevenue_cents: 133333,
      atRiskAccessorialRevenue_cents: 3333,
      upsideIfAllAccessorialsPay_cents: -33387,
      driverPay_cents: 27778,
      trueTripCost_cents: 170053,
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
    expect(
      ok(load({ otherAccessorialRevenue_cents: 7500, detentionTermsKnown: true })),
    ).toMatchObject({
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
  //     cost 85000+5000+16500+4400+2000+40000+50000 = 202900 ; net 27100 ; /day 13550
  it("G15 no fuel discount — negotiate", () => {
    expect(ok(load({ fuelDiscount_cents_per_gal: 0 }))).toMatchObject({
      effectiveDieselPrice_cents_per_gal: 400,
      fuelCost_cents: 85000,
      trueTripCost_cents: 202900,
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
      trueTripCost_cents: 237275,
      trueEstimatedNet_cents: -7275,
      netPerAvailableDay_cents: -3638,
      verdict: "skip",
    });
  });

  // G17 pure loaded run, no empty miles at all. 500 loaded, 0 empty -> 500 total.
  //     fuel 500*1000*350/5000 = 35000 ; reserves 15*500 = 7500, 4*500 = 2000
  //     pay 25% of 150000 = 37500 ; cost 35000+5000+7500+2000+2000+40000+37500 = 129000
  //     net 150000-129000 = 21000 ; break-even 180*500 = 90000 ; target 220*500 = 110000
  //     rpm 150000000/500 = 300000 ; /day 21000*1440/2880 = 10500
  it("G17 no empty miles — take", () => {
    expect(
      ok(
        load({
          linehaulRevenue_cents: 150000,
          passThroughRevenue_cents: 0,
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
      trueTripCost_cents: 129000,
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
      trueTripCost_cents: 192275,
      trueEstimatedNet_cents: 37725,
      verdict: "negotiate",
    });
  });

  // G19 percent that rounds DOWN: 123457*3333/10000 = 41148.2181 -> 41148
  //     gross 123457 ; cost 74375+5000+16500+4400+2000+40000+41148 = 183423 ; net -59966
  //     rpm 123457000/1100 = 112233.6 -> 112234 ; /day -(59966*1440/2880 = 29983)
  it("G19 percent pay rounds down when below the half — skip", () => {
    expect(
      ok(
        load({
          linehaulRevenue_cents: 123457,
          passThroughRevenue_cents: 0,
          driverPay: { type: "percent", percent_bp: 3333 },
        }),
      ),
    ).toMatchObject({
      driverPay_cents: 41148,
      trueTripCost_cents: 183423,
      trueEstimatedNet_cents: -59966,
      allInRpm_millicents_per_mile: 112234,
      netPerAvailableDay_cents: -29983,
      verdict: "skip",
    });
  });

  // G20 dispatch-service shape: no driver pay line, 10% dispatch fee on linehaul.
  //     haircut 20000 ; cost 74375+5000+16500+4400+2000+40000+0+20000 = 162275
  //     net 67725 ; /day 67725*1440/2880 = 33862.5 -> 33863
  it("G20 dispatch fee instead of driver pay — negotiate", () => {
    expect(
      ok(load({ driverPay: { type: "none" }, brokerOrDispatchHaircut_bp: 1000 })),
    ).toMatchObject({
      driverPay_cents: 0,
      brokerOrDispatchHaircut_cents: 20000,
      trueTripCost_cents: 162275,
      trueEstimatedNet_cents: 67725,
      netPerAvailableDay_cents: 33863,
      verdict: "negotiate",
    });
  });
});

describe("detention — decision 3, never estimated into the net", () => {
  it("contributes exactly 0 cents and is surfaced as a flag when terms are unknown", () => {
    const unknown = ok(load());
    const known = ok(load({ detentionTermsKnown: true }));

    expect(unknown.trueEstimatedNet_cents).toBe(known.trueEstimatedNet_cents);
    expect(unknown.riskFlags).toContain(
      "Detention terms/hours unknown — not included in estimated net.",
    );
    expect(unknown.missingFacts).toEqual(["detentionTermsKnown"]);
    expect(known.riskFlags).toEqual([]);
  });

  it("says so in the assumptions rather than leaving the driver to infer it", () => {
    expect(ok(load()).assumptions.detentionBasis).toMatch(/never estimated/);
  });
});

describe("fail closed — NEEDS_INPUT names the field, never a default", () => {
  it("reports a missing revenue field", () => {
    const { linehaulRevenue_cents: _omitted, ...rest } = load();
    const result = calculateTrueNet(rest);
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    expect(result.missing).toContain("linehaulRevenue_cents");
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
    const result = calculateTrueNet({ linehaulRevenue_cents: 1000 });
    expect(result.status).toBe("NEEDS_INPUT");
    if (result.status !== "NEEDS_INPUT") return;
    expect(result.missing.length).toBeGreaterThan(5);
    expect(result.missing).toContain("loadedMiles");
    expect(result.missing).toContain("driverPay");
  });
});

describe("guards — a broken input throws instead of producing a dollar figure", () => {
  it("throws on NaN", () => {
    expect(() => calculateTrueNet(load({ linehaulRevenue_cents: Number.NaN }))).toThrow(
      TrueNetError,
    );
  });

  it("throws on Infinity", () => {
    expect(() => calculateTrueNet(load({ tolls_cents: Number.POSITIVE_INFINITY }))).toThrow(
      /not finite/,
    );
  });

  it("throws on a fractional cent — the money path is integers only", () => {
    expect(() => calculateTrueNet(load({ linehaulRevenue_cents: 1000.5 }))).toThrow(
      /must be an integer/,
    );
  });

  it("throws on negative revenue", () => {
    expect(() => calculateTrueNet(load({ tolls_cents: -1 }))).toThrow(/must not be negative/);
  });

  it("throws when the fuel discount exceeds the posted price", () => {
    expect(() =>
      calculateTrueNet(
        load({ regionalDieselPrice_cents_per_gal: 100, fuelDiscount_cents_per_gal: 200 }),
      ),
    ).toThrow(/discount exceeds/);
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

function randomLoad(next: () => number): TrueNetInput {
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const payRoll = next();
  const driverPay: TrueNetInput["driverPay"] =
    payRoll < 0.34
      ? { type: "none" }
      : payRoll < 0.67
        ? { type: "percent", percent_bp: int(0, 4000) }
        : { type: "perMile", rate_cents_per_mile: int(0, 90) };

  return {
    linehaulRevenue_cents: int(0, 500_000),
    passThroughRevenue_cents: int(0, 100_000),
    otherAccessorialRevenue_cents: int(0, 50_000),
    loadedMiles: int(1, 2500),
    deadheadMiles: int(0, 400),
    repositionMiles: int(0, 400),
    mpgLoaded_milli: int(3000, 9000),
    mpgEmpty_milli: int(3000, 12000),
    regionalDieselPrice_cents_per_gal: int(250, 650),
    fuelDiscount_cents_per_gal: int(0, 120),
    tolls_cents: int(0, 40_000),
    maintenanceReserve_cents_per_mile: int(0, 40),
    tireReserve_cents_per_mile: int(0, 15),
    knownExpenses_cents: int(0, 30_000),
    tripMinutes: int(60, 10_080),
    overhead_cents_per_day: int(0, 60_000),
    driverPay,
    brokerOrDispatchHaircut_bp: int(0, 2500),
    breakEven_cents_per_mile: int(80, 300),
    target_cents_per_mile: int(150, 450),
  };
}

describe("properties — hold across 500 generated loads", () => {
  const cases: TrueNetOk[] = [];
  const next = lcg(0x3b_10_09);
  for (let n = 0; n < 500; n++) cases.push(ok(randomLoad(next)));

  it("gross revenue is exactly the sum of the three buckets — no double count", () => {
    for (const r of cases) {
      expect(r.grossRevenue_cents).toBe(
        r.linehaulRevenue_cents + r.passThroughRevenue_cents + r.otherAccessorialRevenue_cents,
      );
    }
  });

  it("[Rev 2] net is exactly RELIABLE revenue minus trip cost — at-risk dollars never enter it", () => {
    for (const r of cases) {
      expect(r.trueEstimatedNet_cents).toBe(r.reliableRevenue_cents - r.trueTripCost_cents);
    }
  });

  it("[Rev 2] gross = reliable + at-risk, and upside = net + at-risk — the split is exhaustive", () => {
    for (const r of cases) {
      expect(r.reliableRevenue_cents).toBe(r.linehaulRevenue_cents + r.passThroughRevenue_cents);
      expect(r.atRiskAccessorialRevenue_cents).toBe(r.otherAccessorialRevenue_cents);
      expect(r.grossRevenue_cents).toBe(r.reliableRevenue_cents + r.atRiskAccessorialRevenue_cents);
      expect(r.upsideIfAllAccessorialsPay_cents).toBe(r.trueEstimatedNet_cents + r.atRiskAccessorialRevenue_cents);
    }
  });

  it("[Rev 2] adding confirmed accessorials never moves the verdict or the net", () => {
    const next = lcg(20260911);
    for (let n = 0; n < 500; n += 1) {
      const base = randomLoad(next);
      const original = ok(base);
      const extra = 1 + Math.floor(next() * 50000);
      const bumped = ok({
        ...base,
        otherAccessorialRevenue_cents: base.otherAccessorialRevenue_cents + extra,
        detentionTermsKnown: true,
      });
      expect(bumped.verdict).toBe(original.verdict);
      expect(bumped.trueEstimatedNet_cents).toBe(original.trueEstimatedNet_cents);
      expect(bumped.atRiskAccessorialRevenue_cents).toBe(original.atRiskAccessorialRevenue_cents + extra);
      expect(bumped.grossRevenue_cents).toBe(original.grossRevenue_cents + extra);
    }
  });

  it("trip cost is exactly the sum of its components", () => {
    for (const r of cases) {
      expect(r.trueTripCost_cents).toBe(
        r.fuelCost_cents +
          r.tolls_cents +
          r.maintenanceReserve_cents +
          r.tireReserve_cents +
          r.knownExpenses_cents +
          r.overhead_cents +
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
      "upsideIfAllAccessorialsPay_cents",
      "fuelCost_cents",
      "maintenanceReserve_cents",
      "tireReserve_cents",
      "overhead_cents",
      "driverPay_cents",
      "brokerOrDispatchHaircut_cents",
      "trueTripCost_cents",
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

  it("percent driver pay never responds to non-linehaul revenue", () => {
    const replay = lcg(0x3b_10_09);
    for (let n = 0; n < 500; n++) {
      const input = randomLoad(replay);
      if (input.driverPay.type !== "percent") continue;
      const bumped = ok({
        ...input,
        passThroughRevenue_cents: input.passThroughRevenue_cents + 25_000,
        otherAccessorialRevenue_cents: input.otherAccessorialRevenue_cents + 25_000,
      });
      const original = ok(input);
      expect(bumped.driverPay_cents).toBe(original.driverPay_cents);
      expect(bumped.brokerOrDispatchHaircut_cents).toBe(original.brokerOrDispatchHaircut_cents);
    }
  });

  it("more linehaul revenue never makes the verdict worse", () => {
    const rank = { skip: 0, negotiate: 1, take: 2 } as const;
    const replay = lcg(0x3b_10_09);
    for (let n = 0; n < 500; n++) {
      const input = randomLoad(replay);
      const richer = ok({
        ...input,
        linehaulRevenue_cents: input.linehaulRevenue_cents + 100_000,
      });
      const original = ok(input);
      expect(rank[richer.verdict]).toBeGreaterThanOrEqual(rank[original.verdict]);
    }
  });

  it("stamps the calculator version and the full input set on every result", () => {
    for (const r of cases) {
      expect(r.calcVersion).toBe(CALC_VERSION);
      expect(r.input.linehaulRevenue_cents).toBe(r.linehaulRevenue_cents);
    }
  });

  it("always explains itself — a number with no derivation is not shippable", () => {
    for (const r of cases) {
      expect(r.reasons.length).toBeGreaterThan(0);
      expect(r.assumptions.calculatedFrom).toMatch(/total miles/);
      expect(r.assumptions.confidence.length).toBeGreaterThan(0);
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
    expect(ok(load({ linehaulRevenue_cents: 12345 })).driverPay_cents).toBe(3086);
  });

  it("a TRUE half-cent: 12346 x 25% = 3086.5 -> 3087 (floor and banker's would say 3086)", () => {
    expect(ok(load({ linehaulRevenue_cents: 12346 })).driverPay_cents).toBe(3087);
  });

  it("the haircut follows the same rule: 12350 x 5% = 617.5 -> 618", () => {
    expect(
      ok(load({ linehaulRevenue_cents: 12350, brokerOrDispatchHaircut_bp: 500 })).brokerOrDispatchHaircut_cents,
    ).toBe(618);
  });

  it("each multiply is independent from linehaul — the haircut is never taken off a rounded pay subtotal", () => {
    // 12346: pay 25% -> 3087 (half-up) ; haircut 5% -> 617.3 -> 617, computed from 12346, not from 12346-3087.
    const r = ok(load({ linehaulRevenue_cents: 12346, brokerOrDispatchHaircut_bp: 500 }));
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
    expect(r.assumptions.clockBasis).toMatch(/does not price/);
  });

  it("returns NEEDS_INPUT for both outputs when the minutes are unknown — never a default", () => {
    const r = ok(load());
    expect(r.clockHoursConsumed_milli).toBe("NEEDS_INPUT");
    expect(r.netPerAvailableHour_cents).toBe("NEEDS_INPUT");
    expect(r.assumptions.clockBasis).toMatch(/NEEDS_INPUT/);
    // and it does NOT make the net "conservative" — the clock does not touch the net
    expect(r.missingFacts).not.toContain("clockMinutesConsumed");
  });

  it("a zero or non-integer clock is treated as unknown, not as a division", () => {
    expect(ok(load({ clockMinutesConsumed: 0 })).netPerAvailableHour_cents).toBe("NEEDS_INPUT");
    expect(ok(load({ clockMinutesConsumed: 1.5 })).netPerAvailableHour_cents).toBe("NEEDS_INPUT");
  });

  it("the clock never changes the verdict or the net", () => {
    const next = lcg(20260912);
    for (let n = 0; n < 200; n += 1) {
      const base = randomLoad(next);
      const without = ok(base);
      const withClock = ok({ ...base, clockMinutesConsumed: 60 + Math.floor(next() * 600) });
      expect(withClock.verdict).toBe(without.verdict);
      expect(withClock.trueEstimatedNet_cents).toBe(without.trueEstimatedNet_cents);
      expect(Number.isSafeInteger(withClock.netPerAvailableHour_cents)).toBe(true);
    }
  });
});
