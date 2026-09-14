/**
 * EZ-BUILD-01 Slice 11 (10A/10B/10C) — the paywall that is off, and must stay priceless.
 *
 * Two things to prove, and the second one is the ticket's "done when":
 *
 *   1. THERE ARE NO PRICES. Not in the policy, not in the adapter, not in `.env.example`, not
 *      in a message a user would see. D-2 is Andrew's to WRITE, and a price invented by a
 *      builder is a price somebody eventually quotes to a customer.
 *   2. THE PAYWALL SWITCHES ON BY CONFIG WITHOUT TOUCHING A FEATURE — one boolean, no second
 *      code path anywhere, and no feature that knows a plan name.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  GATEABLE_FEATURES,
  NEVER_GATED,
  NO_BILLING_CONFIGURED,
  PLAN_TIERS,
  type EntitlementState,
  type GateableFeature,
  allows,
  isEntitled,
  isPlanTier,
} from "../packages/domain/entitlement.ts";
import {
  BILLING_SECRET_NAMES,
  mockBillingAdapter,
  selectBillingAdapter,
} from "../supabase/functions/_shared/billing.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(`${REPO_ROOT}${rel}`, "utf8");

const BILLING_FILES = [
  "packages/domain/entitlement.ts",
  "supabase/functions/_shared/billing.ts",
] as const;

/** Code lines only. Comments explaining "no prices here" must not count as prices. */
const codeOf = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("//"))
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

describe("there are no prices, anywhere — D-2 is Andrew's to write", () => {
  it("no currency amount appears in either module", () => {
    // $9, $49.00, 4900, 29.99 — any of them.
    for (const f of BILLING_FILES) {
      const code = codeOf(f);
      expect(code, `${f} contains a currency amount`).not.toMatch(/\$\s?\d/);
      expect(code, `${f} contains a decimal amount`).not.toMatch(/\b\d+\.\d{2}\b/);
      expect(code, `${f} contains a cents-shaped constant`).not.toMatch(
        /\b(?:price|amount|cost|fee|cents|usd)\w*\s*[:=]\s*\d/i,
      );
    }
  });

  it("no billing interval, trial length or quantity is declared", () => {
    // "per month", "monthly", "14-day", "annually" — every one of them is a commercial term
    // somebody has to decide, and nobody has.
    for (const f of BILLING_FILES) {
      const code = codeOf(f).toLowerCase();
      for (const term of ["per month", "per-month", "monthly", "annually", "per year", "day trial", "-day", "billing_cycle", "interval:"]) {
        expect(code, `${f} contains "${term}"`).not.toContain(term);
      }
    }
  });

  it("no pricing or outcome claim appears in any user-facing message", async () => {
    // Rule 18: no public pricing or outcome claims before pilot evidence. BUILD_DEFAULTS R-10:
    // the product estimates, it does not promise.
    const checkout = await mockBillingAdapter.startCheckout({
      orgId: "org-1",
      planTier: "pilot_free",
      idempotencyKey: "01JBXR4Q2M8NQ7V3K5ZGABCDEF",
    });
    const messages = [
      isEntitled({ paywallEnabled: true, planTier: "pilot_free" }, "load.create").message ?? "",
      checkout.status === "not_configured" ? checkout.message : "",
    ];
    for (const m of messages) {
      expect(m).not.toMatch(/\$\s?\d|\bfree forever\b|\bupgrade\b|\bsave \d|\bbest value\b/i);
      for (const banned of ["guaranteed", "we'll get you paid", "take-home", "unlimited"]) {
        expect(m.toLowerCase()).not.toContain(banned);
      }
    }
  });

  it("no tier is declared as costing more than another", () => {
    // An ordering between tiers is the first half of a price list.
    const code = codeOf("packages/domain/entitlement.ts");
    expect(code).not.toMatch(/\b(?:upgrade|downgrade|higher tier|premium|pro\b|enterprise)\b/i);
    // Two identifiers, and nothing said about the relationship between them.
    expect([...PLAN_TIERS]).toEqual(["pilot_free", "paid_placeholder"]);
  });

  it(".env.example names the secrets and holds no value", () => {
    // Names and placeholders only, ever. `check:env` enforces this repo-wide; this asserts the
    // two names this slice adds are there and are empty.
    const env = read(".env.example");
    for (const name of BILLING_SECRET_NAMES) {
      expect(env, `.env.example does not declare ${name}`).toContain(name);
      expect(env).toMatch(new RegExp(`^${name}=\\s*$`, "m"));
    }
  });
});

describe("the done-when: the paywall switches on by config, touching no feature", () => {
  const off: EntitlementState = { paywallEnabled: false, planTier: "pilot_free" };
  const on: EntitlementState = { paywallEnabled: true, planTier: "pilot_free" };

  it("with the paywall OFF, every gateable feature is allowed", () => {
    for (const f of GATEABLE_FEATURES) {
      expect(isEntitled(off, f)).toEqual({ allowed: true, reason: "paywall_disabled", message: undefined });
    }
  });

  it("with it ON, the gate actually bites — so the switch is not decorative", () => {
    for (const f of GATEABLE_FEATURES) {
      if ((NEVER_GATED as readonly string[]).includes(f)) continue;
      expect(allows(on, f), `${f} was still allowed with the paywall on`).toBe(false);
    }
  });

  it("is one boolean, and the default everywhere is off", () => {
    expect(NO_BILLING_CONFIGURED.paywallEnabled).toBe(false);
    expect(NO_BILLING_CONFIGURED.planTier).toBe("pilot_free");
  });

  it("no feature module imports the entitlement policy or a plan name", async () => {
    // The whole point: turning the paywall on must not require touching a feature. If a handler
    // imported a plan tier, it would have a second code path and this would stop being true.
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(`${REPO_ROOT}${dir}`)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const rel = `${dir}/${entry}`;
        if (statSync(`${REPO_ROOT}${rel}`).isDirectory()) walk(rel, out);
        else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(rel);
      }
      return out;
    };
    const features = [...walk("supabase/functions"), ...walk("packages/domain"), ...walk("src")].filter(
      (f) => !f.endsWith("entitlement.ts") && !f.endsWith("billing.ts"),
    );
    expect(features.length).toBeGreaterThan(10);
    for (const f of features) {
      const code = codeOf(f);
      expect(code, `${f} imports the entitlement policy`).not.toMatch(/from ["'][^"']*entitlement\.ts["']/);
      expect(code, `${f} mentions a plan tier`).not.toMatch(/pilot_free|paid_placeholder/);
    }
  });
});

describe("the policy fails OPEN, and says so out loud", () => {
  it("an unknown entitlement allows the work through", () => {
    // The opposite of every other default in this codebase, which is exactly why it is asserted
    // rather than left to be inferred. An entitlement check is not a security boundary — RLS and
    // the capability matrix are — and a truck on the shoulder at 2am is not the moment to
    // discover that a billing lookup timed out.
    const state: EntitlementState = { paywallEnabled: true, planTier: "pilot_free", unknown: true };
    for (const f of GATEABLE_FEATURES) {
      expect(isEntitled(state, f).allowed).toBe(true);
    }
    expect(isEntitled(state, "load.create").reason).toBe("entitlement_unknown_failed_open");
  });

  it("reading a carrier's own data is never gated, even with the paywall on", () => {
    // Withholding a driver's own records over billing is not a paywall, it is a hostage.
    for (const f of NEVER_GATED) {
      expect(isEntitled({ paywallEnabled: true, planTier: "pilot_free" }, f as GateableFeature).allowed).toBe(true);
    }
    expect([...NEVER_GATED]).toEqual(["load.read", "document.upload"]);
  });

  it("uploading a document is never gated either, and the reason is arithmetic", () => {
    // A POD that cannot be uploaded is a POD that cannot be invoiced, and a driver who cannot
    // invoice cannot pay.
    expect(NEVER_GATED).toContain("document.upload");
  });

  it("an unrecognised plan tier is refused as a tier, not passed through as a string", () => {
    expect(isPlanTier("pilot_free")).toBe(true);
    expect(isPlanTier("enterprise")).toBe(false);
    expect(isPlanTier(null)).toBe(false);
  });

  it("the refusal message tells a person what to do and names no price", () => {
    const d = isEntitled({ paywallEnabled: true, planTier: "pilot_free" }, "load.create");
    expect(d.allowed).toBe(false);
    expect(d.message).toBe("This is not included in your current plan. Contact EZ Trucking to enable it.");
  });
});

describe("the billing adapter sells nothing, and cannot grant anything", () => {
  it("with no key configured, the mock answers", () => {
    expect(selectBillingAdapter([]).name).toBe("mock");
  });

  it("and with a key configured it STILL answers — a key alone cannot start billing anyone", () => {
    // The safer of the two defaults: a secret appearing in an environment must not by itself
    // begin charging customers.
    expect(selectBillingAdapter(["STRIPE_SECRET_KEY"]).name).toBe("mock");
  });

  it("checkout is `not_configured`, and that is a SUCCESS rather than an error", () => {
    // The caller is not broken. The product has no price.
    return mockBillingAdapter
      .startCheckout({ orgId: "org-1", planTier: "pilot_free", idempotencyKey: "01JBXR4Q2M8NQ7V3K5ZGABCDEF" })
      .then((r) => {
        expect(r.status).toBe("not_configured");
        expect(r).not.toHaveProperty("url");
      });
  });

  it("a payment event NEVER grants access by itself — it only names a tier", () => {
    // The rule that outlives this file, and the same reasoning as R-6: a body from outside is a
    // claim, not a permission. The event yields a fact; the policy reads the fact.
    const change = mockBillingAdapter.planChangeFromEvent({
      id: "evt_1",
      org_id: "org-1",
      plan_tier: "paid_placeholder",
    });
    expect(change).toEqual({ orgId: "org-1", planTier: "paid_placeholder", eventId: "evt_1" });
    expect(Object.keys(change ?? {}).sort()).toEqual(["eventId", "orgId", "planTier"]);
    // Nothing in the returned shape is a permission, a capability or an allow flag.
    expect(JSON.stringify(change)).not.toMatch(/allow|grant|entitled|capab/i);
  });

  it("an event with an unrecognised tier is refused, not passed through", () => {
    expect(mockBillingAdapter.planChangeFromEvent({ id: "e", org_id: "o", plan_tier: "enterprise" })).toBeNull();
    expect(mockBillingAdapter.planChangeFromEvent({ id: "e", org_id: "o" })).toBeNull();
    expect(mockBillingAdapter.planChangeFromEvent(null)).toBeNull();
    expect(mockBillingAdapter.planChangeFromEvent("paid")).toBeNull();
  });

  it("carries an idempotency key, same contract as 2E", () => {
    // A double-tap on a payment button is the one place a duplicate costs real money.
    const code = codeOf("supabase/functions/_shared/billing.ts");
    expect(code).toMatch(/idempotencyKey: string/);
  });

  it("makes no network call and reads no secret value", () => {
    const code = codeOf("supabase/functions/_shared/billing.ts");
    expect(code).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|https:\/\//);
    expect(code).not.toMatch(/process\s*\.\s*env|Deno\s*\.\s*env/);
    // It names the secrets it would one day need. Names are not values.
    expect([...BILLING_SECRET_NAMES]).toEqual(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
  });

  it("takes the ALREADY-VERIFIED payload, so it is not where a forged webhook becomes access", () => {
    const src = read("supabase/functions/_shared/billing.ts");
    expect(src).toMatch(/ALREADY-VERIFIED/);
    expect(codeOf("supabase/functions/_shared/billing.ts")).toMatch(/planChangeFromEvent: \(verified/);
  });
});

describe("the entitlement policy stays pure", () => {
  it("no import, no clock, no environment, no network", () => {
    const code = codeOf("packages/domain/entitlement.ts");
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/Date\.now\(|new Date\(|fetch\(|process\s*\.\s*env/);
  });

  it("the same arguments give the same answer", () => {
    const s: EntitlementState = { paywallEnabled: true, planTier: "pilot_free" };
    expect(isEntitled(s, "load.create")).toEqual(isEntitled(s, "load.create"));
  });
});
