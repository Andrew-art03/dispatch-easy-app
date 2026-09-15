/**
 * EZ-BUILD-02 Slice 2 — how complete is this truck profile, as a pure function.
 *
 * WHY IT LIVES HERE RATHER THAN INSIDE THE COMPONENT. It was two lines in
 * `TruckProfile.tsx`, computed during render, which meant the only way to test it was to
 * mount React and read a percentage off the DOM. Slice 2's done-when asks for a unit test
 * on it, and a number a driver reads as "how ready am I" deserves one that does not depend
 * on a rendering library.
 *
 * WHAT THE NUMBER MEANS, and what it must never become. It is "how many of the figures EZ
 * needs to price a load have you given us" — a prompt, not a score, and never a judgement
 * about the driver or the truck. It is deliberately NOT weighted: every required field
 * counts once, because weighting invites an argument about which figure matters most that
 * the product does not need to have, and a driver cannot reverse-engineer a weighted bar.
 *
 * `hazmat` and `banned_states` are excluded on purpose — both are legitimately empty for
 * most carriers, so counting them would cap an honest profile below 100% forever.
 */

/** The fields the estimate needs. Everything here is typed by the driver. */
export const REQUIRED_TRUCK_FIELDS = [
  "unit_number",
  "equipment",
  "mpg_loaded",
  "mpg_empty",
  "fuel_discount_per_gal",
  "maintenance_reserve_per_mile",
  "tire_reserve_per_mile",
  "overhead_per_day",
  "driver_pay_type",
  "driver_pay_value",
  "cpm_target",
  "max_deadhead_miles",
  "height_ft",
  "length_ft",
  "weight_lb",
  "hos_hours_left",
  "home_base_lat",
  "home_base_lng",
] as const;

export type RequiredTruckField = (typeof REQUIRED_TRUCK_FIELDS)[number];

/** Any shape whose required keys can be read as text — the form uses strings throughout. */
export type TruckCompletenessInput = Partial<Record<RequiredTruckField, unknown>>;

/**
 * A field counts as filled when it has a non-blank value.
 *
 * `null` and `undefined` are blank; so is whitespace, because a space bar pressed by
 * accident is not an answer. `0` and `false` are NOT blank — `fuel_discount_per_gal` of 0
 * is a real answer from a driver with no fuel card, and treating it as missing would tell
 * them to go and fill in a field they have already filled in correctly.
 */
export function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  return true;
}

/** Which required fields are still blank, in the order the form presents them. */
export function missingTruckFields(form: TruckCompletenessInput): RequiredTruckField[] {
  return REQUIRED_TRUCK_FIELDS.filter((key) => !isFilled(form[key]));
}

/**
 * Completeness as a whole percentage, 0–100.
 *
 * Rounded, and the rounding is the reason the two endpoints are special-cased below: with
 * 18 fields, 17 of them filled rounds to 94% and one of them filled rounds to 6%, but
 * `Math.round` alone would also let 17.5/18 display as 100% if the list ever grew. A bar
 * that says 100% while a field is still empty is a bar that has lied to the driver once,
 * which is enough to stop them trusting it — so 100% means "nothing missing", exactly.
 */
export function truckCompleteness(form: TruckCompletenessInput): number {
  const missing = missingTruckFields(form).length;
  if (missing === 0) return 100;
  const filled = REQUIRED_TRUCK_FIELDS.length - missing;
  if (filled === 0) return 0;
  return Math.min(99, Math.max(1, Math.round((filled / REQUIRED_TRUCK_FIELDS.length) * 100)));
}
