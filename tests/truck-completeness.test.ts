/**
 * EZ-BUILD-02 Slice 2 — the completeness percentage, which a driver reads as
 * "how ready am I". Slice 2's done-when asks for this test by name.
 *
 * It is in the OFFLINE suite: the function is pure, so it needs no database and no
 * browser, and a number this visible should be checkable in milliseconds.
 */
import { describe, expect, it } from "vitest";

import {
  REQUIRED_TRUCK_FIELDS,
  isFilled,
  missingTruckFields,
  truckCompleteness,
  type TruckCompletenessInput,
} from "@/lib/truck-completeness";

/** A profile with every required field answered. */
const complete: TruckCompletenessInput = Object.fromEntries(
  REQUIRED_TRUCK_FIELDS.map((key) => [key, "answered"]),
);

describe("truckCompleteness", () => {
  it("is 0 when nothing has been filled in", () => {
    expect(truckCompleteness({})).toBe(0);
  });

  it("is 100 only when nothing is missing", () => {
    expect(truckCompleteness(complete)).toBe(100);
  });

  it("never reports 100 while a field is still blank", () => {
    // The one that matters. A bar that says 100% with a field empty has lied to the
    // driver once, and once is enough for them to stop believing it.
    for (const key of REQUIRED_TRUCK_FIELDS) {
      const oneMissing = { ...complete, [key]: "" };
      expect(truckCompleteness(oneMissing), `blank ${key} must not read 100`).toBeLessThan(100);
    }
  });

  it("never reports 0 once something has been filled in", () => {
    // The mirror of the case above: a driver who has answered a question should see the
    // bar move, or they will reasonably conclude the screen is not listening.
    for (const key of REQUIRED_TRUCK_FIELDS) {
      const onlyOne = { [key]: "answered" };
      expect(truckCompleteness(onlyOne), `${key} alone must not read 0`).toBeGreaterThan(0);
    }
  });

  it("climbs as fields are answered, and never goes backwards", () => {
    let previous = -1;
    const form: TruckCompletenessInput = {};
    for (const key of REQUIRED_TRUCK_FIELDS) {
      form[key] = "answered";
      const now = truckCompleteness(form);
      expect(now).toBeGreaterThan(previous);
      previous = now;
    }
    expect(previous).toBe(100);
  });

  it("counts a real zero as answered", () => {
    // `fuel_discount_per_gal: 0` is the correct answer for a driver with no fuel card.
    // Treating it as missing would send them to fill in a field they have already filled
    // in correctly — the kind of small wrongness that makes a screen feel broken.
    const withZero = { ...complete, fuel_discount_per_gal: 0 };
    expect(truckCompleteness(withZero)).toBe(100);
    expect(missingTruckFields(withZero)).toEqual([]);
  });

  it("does not count whitespace as an answer", () => {
    expect(truckCompleteness({ ...complete, unit_number: "   " })).toBeLessThan(100);
  });

  it("names exactly what is still missing, in form order", () => {
    // The list is what lets the screen say "3 things left" and point at them, rather than
    // leaving the driver to hunt for the blank box.
    const partial = { ...complete, cpm_target: "", weight_lb: null, home_base_lng: undefined };
    expect(missingTruckFields(partial)).toEqual(["cpm_target", "weight_lb", "home_base_lng"]);
  });

  it("is not vacuous — the required list is the one the form actually uses", () => {
    // A list that quietly emptied would make every profile 100% complete and this whole
    // suite green. 18 is the current count; changing it is a deliberate line in a diff.
    expect(REQUIRED_TRUCK_FIELDS.length).toBe(18);
    expect(new Set(REQUIRED_TRUCK_FIELDS).size).toBe(REQUIRED_TRUCK_FIELDS.length);
  });
});

describe("isFilled", () => {
  it("treats blank-ish values as unanswered", () => {
    expect(isFilled(null)).toBe(false);
    expect(isFilled(undefined)).toBe(false);
    expect(isFilled("")).toBe(false);
    expect(isFilled("  \t ")).toBe(false);
    expect(isFilled(Number.NaN)).toBe(false);
  });

  it("treats real answers as answered, including 0 and false", () => {
    expect(isFilled(0)).toBe(true);
    expect(isFilled(false)).toBe(true);
    expect(isFilled("van")).toBe(true);
    expect(isFilled(6.5)).toBe(true);
  });
});
