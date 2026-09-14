/**
 * EZ-BUILD-01 Slice 11 (tickets 10A/10B/10C) — the entitlement policy. PLACEHOLDERS ONLY.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THERE ARE NO PRICES IN THIS FILE, AND THERE MUST NOT BE.
 *
 * BUILD_DEFAULTS §2: money/payment is the last slice and carries placeholders only until Andrew
 * writes the numbers. D-2 is his. Not "his to approve" — his to WRITE. A price invented by a
 * builder is a price somebody eventually quotes to a customer, and CLAUDE.md rule 5 puts money
 * in the founder's hands for exactly that reason.
 *
 * So: no amount, no currency figure, no interval, no trial length, no tier comparison, no
 * marketing sentence. `tests/entitlement.test.ts` asserts their absence rather than trusting
 * this paragraph, and it scans this file for digits that could be a price.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE ONE THING THIS HAS TO GET RIGHT: the paywall switches on by CONFIG, without touching a
 * feature. That is SPEC 10's "done when", and it is the difference between a paywall and a
 * rewrite. Every feature asks the same question — `isEntitled(state, feature)` — and when the
 * paywall is off, the answer is always yes. Nothing downstream has a second code path, no
 * feature imports a plan name, and turning it on is one boolean.
 *
 * FAIL OPEN, DELIBERATELY, AND ONLY HERE. An entitlement check is not a security boundary: RLS
 * and the capability matrix are. If this file cannot tell whether a carrier has paid, the right
 * answer during a pilot is to let the driver work — a truck on the shoulder at 2am is not the
 * moment to discover that a billing lookup timed out. That is the OPPOSITE of every other
 * default in this codebase, so it is written down here and asserted in a test rather than left
 * for someone to infer from the code.
 *
 * PURE. No network, no clock, no environment (BUILD_DEFAULTS §3). The paywall flag and the plan
 * are both arguments.
 */

/**
 * The plan a carrier's `org.plan_tier` column holds. `pilot_free` is the 0003 default and is
 * the only value that exists today.
 *
 * These are IDENTIFIERS, not products. No price, no feature list, no ordering between them is
 * declared here, because declaring an ordering is the first half of declaring a price list.
 */
export const PLAN_TIERS = ["pilot_free", "paid_placeholder"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === "string" && (PLAN_TIERS as readonly string[]).includes(value);
}

/**
 * Everything a paywall could ever gate, named once.
 *
 * Two of them can never be gated, and that is a product decision already made elsewhere rather
 * than one I am making here:
 *   `load.read`       a carrier can always see their own data. Withholding a driver's own
 *                     records over billing is not a paywall, it is a hostage.
 *   `document.upload` a POD that cannot be uploaded is a POD that cannot be invoiced, and a
 *                     driver who cannot invoice cannot pay. Gating it is self-defeating.
 */
export const GATEABLE_FEATURES = [
  "load.create",
  "load.score",
  "agent.skill",
  "voice.session",
  "week.report",
] as const;
export type GateableFeature = (typeof GATEABLE_FEATURES)[number];

export const NEVER_GATED = ["load.read", "document.upload"] as const;

export interface EntitlementState {
  /**
   * The master switch. FALSE today and in every environment, because there is nothing to
   * charge for yet and no price to charge. Flipping it is a config change and nothing else.
   */
  readonly paywallEnabled: boolean;
  readonly planTier: PlanTier;
  /**
   * Set when the entitlement could not be determined — a lookup failed, the row was missing,
   * the column held something unrecognised. See the fail-open note in the header.
   */
  readonly unknown?: boolean | undefined;
}

export interface EntitlementDecision {
  readonly allowed: boolean;
  /** Machine-readable, for a log. Never shown to a driver as-is. */
  readonly reason:
    | "paywall_disabled"
    | "feature_never_gated"
    | "entitled"
    | "entitlement_unknown_failed_open"
    | "not_entitled";
  /**
   * What a person is told. Deliberately says what to do next and names no price — there is no
   * price to name, and a message that invents one is worse than a message that does not.
   */
  readonly message: string | undefined;
}

/**
 * May this org use this feature?
 *
 * Pure and total. The order of the checks IS the policy, so it is written so a reader can see
 * it without running it.
 */
export function isEntitled(state: EntitlementState, feature: GateableFeature): EntitlementDecision {
  // 1. The master switch. Off means every feature behaves exactly as it did before this file
  //    existed — which is the "without touching a feature" half of the done-when.
  if (!state.paywallEnabled) {
    return { allowed: true, reason: "paywall_disabled", message: undefined };
  }

  // 2. Features that are never gated, even with the paywall on.
  if ((NEVER_GATED as readonly string[]).includes(feature)) {
    return { allowed: true, reason: "feature_never_gated", message: undefined };
  }

  // 3. Fail open on an unknown entitlement. Not a security boundary — see the header.
  if (state.unknown === true) {
    return { allowed: true, reason: "entitlement_unknown_failed_open", message: undefined };
  }

  // 4. The actual check. A placeholder, and the whole of it: `pilot_free` is the only tier that
  //    exists, and whether IT is entitled to anything once a paywall exists is D-2's to answer.
  //    Until then this branch is unreachable in every environment, because step 1 returns first.
  if (state.planTier === "paid_placeholder") {
    return { allowed: true, reason: "entitled", message: undefined };
  }

  return {
    allowed: false,
    reason: "not_entitled",
    // No price, no tier name, no "upgrade for $X". Says what happened and who to talk to.
    message: "This is not included in your current plan. Contact EZ Trucking to enable it.",
  };
}

/**
 * The whole gate, for a caller that just wants a boolean.
 *
 * A separate export because `isEntitled` returns a reason a caller should log, and a caller
 * that only branches on `.allowed` should not have to destructure to say so.
 */
export function allows(state: EntitlementState, feature: GateableFeature): boolean {
  return isEntitled(state, feature).allowed;
}

/**
 * The state a system with no billing configured at all is in.
 *
 * Named rather than written inline at each call site, so "what happens with no billing?" has
 * exactly one answer and it is greppable.
 */
export const NO_BILLING_CONFIGURED: EntitlementState = {
  paywallEnabled: false,
  planTier: "pilot_free",
};
