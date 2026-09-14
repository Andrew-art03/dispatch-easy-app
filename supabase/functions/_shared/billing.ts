/**
 * EZ-BUILD-01 Slice 11 (tickets 10A/10B/10C) — the billing adapter. SCAFFOLDING ONLY.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * NO PRICES. NO PRICING COPY. NO LIVE KEY. NO NETWORK CALL.
 *
 * BUILD_DEFAULTS §2 and the ticket both say it: placeholders only until Andrew writes the
 * numbers, and D-2 is his to WRITE, not merely to approve. This file therefore contains no
 * amount, no currency figure, no interval, no trial length and no marketing sentence — and
 * `tests/entitlement.test.ts` asserts that rather than trusting this paragraph.
 *
 * WHAT IT DOES CONTAIN is the seam: a typed server-side adapter with one implementation that
 * needs no key at all. BUILD_DEFAULTS §5 — "if a key is missing, use the deterministic mock
 * adapter and keep going. Never wait for a key." So the mock is not a placeholder for the real
 * thing; it IS the pilot's implementation, and it stays until there is something to charge.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY THE ADAPTER EXISTS AT ALL IF IT DOES NOTHING. Because the shape is the decision. Writing
 * the interface now fixes three things that are expensive to change later and free to get right
 * today: that billing is server-side only, that it never mints an entitlement by itself, and
 * that every call is idempotent by construction. A Stripe integration bolted on afterwards
 * tends to acquire all three the hard way.
 *
 * THE RULE THAT OUTLIVES THIS FILE: **a payment event never grants access on its own.** It
 * writes a fact — "this org's tier is now X" — and the entitlement policy reads the tier. There
 * is no code path where a webhook body decides what a user may do, for the same reason R-6 says
 * tenancy comes from identity: a body from outside is a claim, not a permission.
 */
import { type PlanTier, isPlanTier } from "../../../packages/domain/entitlement.ts";

/** The secret NAMES this adapter may ever read. Values live in the secret store, never here. */
export const BILLING_SECRET_NAMES = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const;

export type BillingProviderName = "mock" | "stripe";

export interface CheckoutRequest {
  readonly orgId: string;
  /**
   * The plan the org is moving TO. An identifier, not a product: no price is attached here and
   * none is looked up, because there is no price list.
   */
  readonly planTier: PlanTier;
  /** Idempotency, same contract as 2E. One user action, one key, kept across retries. */
  readonly idempotencyKey: string;
}

export type CheckoutResult =
  /** A link a human follows. Never a completed payment — nothing is charged server-side. */
  | { readonly status: "created"; readonly provider: BillingProviderName; readonly url: string }
  /**
   * There is nothing to sell yet. This is the honest answer during the pilot and it is a
   * SUCCESS, not an error: the caller is not broken, the product simply has no price.
   */
  | { readonly status: "not_configured"; readonly provider: BillingProviderName; readonly message: string };

/** A payment event, reduced to the only thing the rest of the system is allowed to care about. */
export interface PlanChange {
  readonly orgId: string;
  readonly planTier: PlanTier;
  /** The provider's event id, so the same event applied twice changes nothing. */
  readonly eventId: string;
}

export interface BillingAdapter {
  readonly name: BillingProviderName;
  readonly startCheckout: (req: CheckoutRequest) => Promise<CheckoutResult>;
  /**
   * Turn a verified provider event into a plan change, or null.
   *
   * Takes the ALREADY-VERIFIED payload. Signature verification is the caller's job and belongs
   * with the secret; passing an unverified body in here would make this function the place a
   * forged webhook becomes an entitlement.
   */
  readonly planChangeFromEvent: (verified: unknown) => PlanChange | null;
}

/**
 * The pilot's adapter. Deterministic, offline, and it sells nothing.
 *
 * It is not a stub waiting to be filled in — it is the correct implementation for a product
 * with no price. When D-2 lands, a `stripe` adapter implements the same interface beside it and
 * the selection is config.
 */
export const mockBillingAdapter: BillingAdapter = {
  name: "mock",

  startCheckout: async (req) => ({
    status: "not_configured",
    provider: "mock",
    // Says what is true. No price, because there is no price; no "coming soon", because that is
    // a claim about timing nobody has made (rule 18: no outcome claims before evidence).
    message: `No payment is required. ${req.orgId.slice(0, 0)}EZ Trucking is in private beta and billing is not enabled.`,
  }),

  planChangeFromEvent: (verified) => {
    // Even here, the event is DATA. Every field is validated before it becomes anything, and an
    // unrecognised tier is refused rather than passed through as a string somebody later trusts.
    if (verified === null || typeof verified !== "object") return null;
    const e = verified as { id?: unknown; org_id?: unknown; plan_tier?: unknown };
    if (typeof e.id !== "string" || typeof e.org_id !== "string") return null;
    if (!isPlanTier(e.plan_tier)) return null;
    return { orgId: e.org_id, planTier: e.plan_tier, eventId: e.id };
  },
};

/**
 * Which adapter is in play.
 *
 * The config, and the whole of it: with no secret configured there is no provider, and the mock
 * answers. This is the "switched on by config without touching any feature" half — no feature
 * imports an adapter, and none of them knows which one answered.
 */
export function selectBillingAdapter(configuredSecretNames: readonly string[]): BillingAdapter {
  const hasKey = configuredSecretNames.includes("STRIPE_SECRET_KEY");
  if (!hasKey) return mockBillingAdapter;
  // A real adapter lands when there is a price to charge and a reviewed key to charge it with.
  // Until then, holding a key changes nothing — which is the safer default of the two, and it
  // means a key appearing in an environment cannot by itself start billing anybody.
  return mockBillingAdapter;
}
