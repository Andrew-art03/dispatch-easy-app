/**
 * EZ-BUILD-01 Slice 9 (ticket 6E) — the week's money, and the leak detector.
 *
 * PURE. Integer cents in, integer cents out, no clock, no I/O (BUILD_DEFAULTS §3, enforced by
 * scripts/assert-domain-purity.mjs). The week boundary is passed IN as an argument, because a
 * function that asks what day it is gives a different answer tomorrow for the same input — and
 * a weekly figure a driver cannot reproduce is a weekly figure a driver will not trust.
 *
 * THE TWO NUMBERS, KEPT APART. R-7, ruled 2026-09-12 and not re-opened:
 *
 *   the DECISION number   what the load was estimated to be worth before the run (3B, PRE_RUN)
 *   the SETTLED number    what actually landed, owned by the ledger (POST_SETTLE)
 *
 * They are different facts and they are never added together, never averaged, and never shown
 * as one figure with a caveat. The leak detector exists precisely because they differ: the gap
 * between them is not an error to hide, it is the product.
 *
 * WHAT THE LANGUAGE MAY NOT DO (R-4, R-10, rule 15). These are estimates and records, never
 * promises: "estimated net (before tax)" and "collected so far" are the only two things a
 * figure here is allowed to claim to be. Not "keep", not "take-home", not "profit", not what
 * anyone is owed.
 */

/** One ledger line, as the money path speaks it: integer cents, always. */
export interface LedgerLine {
  readonly id: string;
  readonly loadId: string | null;
  readonly category: string;
  /** Integer cents. Positive is money in, negative is money out. */
  readonly amountCents: number;
  /** Integer cents actually received against this line. R-7: owned by the ledger. */
  readonly collectedCents: number;
  readonly source: string | null;
  /** ISO-8601. Compared as a string against the week bounds, which are also ISO-8601. */
  readonly at: string;
}

export type Settlement = "NO_REVENUE" | "UNSETTLED" | "PARTIAL" | "SETTLED";

/**
 * DERIVED, never stored — the same rule the database follows in `load_settlement()`. A stored
 * status is a status that can disagree with the rows it claims to summarise, and on the money
 * path that disagreement is the bug nobody finds until a driver asks where their money is.
 *
 * This exists as well as the SQL so a client can show the badge without a round trip, and
 * tests/ledger.test.ts asserts the two agree on the same inputs.
 */
export function settlementOf(lines: readonly LedgerLine[]): Settlement {
  const revenue = lines.filter((l) => l.amountCents > 0);
  const billed = revenue.reduce((n, l) => n + l.amountCents, 0);
  if (billed === 0) return "NO_REVENUE";
  const collected = lines.reduce((n, l) => n + l.collectedCents, 0);
  if (collected === 0) return "UNSETTLED";
  return collected >= billed ? "SETTLED" : "PARTIAL";
}

export interface WeekBounds {
  /** ISO-8601, inclusive. */
  readonly from: string;
  /** ISO-8601, exclusive. */
  readonly to: string;
}

export interface WeekSummary {
  readonly bounds: WeekBounds;
  readonly lineCount: number;
  /** Integer cents billed in the window — what was invoiced, not what arrived. */
  readonly billedCents: number;
  /** Integer cents actually received against those lines. */
  readonly collectedCents: number;
  /** Integer cents of cost lines in the window. Reported as a positive magnitude. */
  readonly costsCents: number;
  /** billed − costs. An estimate of the week, NOT what anyone has been paid. */
  readonly estimatedNetCents: number;
  /** collected − costs. What has actually arrived, less what has actually gone out. */
  readonly collectedNetCents: number;
  readonly settlement: Settlement;
  /** Per category, so a week that looks wrong can be read rather than guessed at. */
  readonly byCategory: Readonly<Record<string, { billedCents: number; collectedCents: number }>>;
  /** The two labels, carried with the numbers so a caller cannot relabel them. */
  readonly labels: { readonly estimated: string; readonly collected: string };
}

export const ESTIMATED_LABEL = "Estimated net (before tax)";
export const COLLECTED_LABEL = "Collected so far";

const inWindow = (at: string, b: WeekBounds): boolean => at >= b.from && at < b.to;

/**
 * Sum one week. Every figure is an integer number of cents, and the two numbers stay apart.
 */
export function weekSummary(lines: readonly LedgerLine[], bounds: WeekBounds): WeekSummary {
  const inside = lines.filter((l) => inWindow(l.at, bounds));

  let billed = 0;
  let collected = 0;
  let costs = 0;
  const byCategory: Record<string, { billedCents: number; collectedCents: number }> = {};

  for (const line of inside) {
    const bucket = byCategory[line.category] ?? { billedCents: 0, collectedCents: 0 };
    if (line.amountCents >= 0) {
      billed += line.amountCents;
    } else {
      // Magnitude, so a reader is never asked to add a negative to a positive in their head.
      costs += -line.amountCents;
    }
    collected += line.collectedCents;
    byCategory[line.category] = {
      billedCents: bucket.billedCents + line.amountCents,
      collectedCents: bucket.collectedCents + line.collectedCents,
    };
  }

  return {
    bounds,
    lineCount: inside.length,
    billedCents: billed,
    collectedCents: collected,
    costsCents: costs,
    estimatedNetCents: billed - costs,
    collectedNetCents: collected - costs,
    settlement: settlementOf(inside),
    byCategory,
    labels: { estimated: ESTIMATED_LABEL, collected: COLLECTED_LABEL },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The leak detector
 * ──────────────────────────────────────────────────────────────────────────── */

export type LeakKind =
  /** Billed, and some or all of it has not arrived. */
  | "uncollected"
  /** The load was estimated to be worth more than the ledger ever billed. */
  | "underbilled"
  /** A cost landed that the estimate did not include at all. */
  | "unestimated_cost"
  /** An accessorial was agreed on the load and never appeared on the ledger. */
  | "missing_accessorial";

export interface Leak {
  readonly kind: LeakKind;
  readonly loadId: string | null;
  readonly category: string | null;
  /** Integer cents. Always a positive magnitude — the direction is in `kind`. */
  readonly cents: number;
  /** Plain language, for a person. States what was observed; promises nothing. */
  readonly note: string;
}

export interface LeakInput {
  readonly loadId: string;
  readonly lines: readonly LedgerLine[];
  /**
   * The decision number for this load — 3B's `trueEstimatedNet_cents` from the score row.
   * `null` when the load was never scored, which is not a leak, it is an absence.
   */
  readonly estimatedNetCents: number | null;
  /**
   * Accessorials agreed on the deal, in integer cents, keyed by category. An agreed accessorial
   * with no ledger line is the classic leak: detention that was earned, agreed, and never billed.
   */
  readonly agreedAccessorialsCents?: Readonly<Record<string, number>> | undefined;
}

/**
 * Find the gaps between what was expected and what the ledger records.
 *
 * IT REPORTS, IT DOES NOT ACT. Every leak is an observation with a number and a sentence. There
 * is no auto-invoice, no auto-chase, no message drafted to anybody — rule 10 and rule 21 both
 * say a human taps before anything leaves the building, and a detector that quietly starts
 * chasing money is the exact shape of the thing those rules forbid.
 *
 * A leak of zero cents is not reported. "Nothing is missing" is not a finding.
 */
export function detectLeaks(input: LeakInput): readonly Leak[] {
  const leaks: Leak[] = [];
  const { loadId, lines } = input;

  const revenue = lines.filter((l) => l.amountCents > 0);
  const billed = revenue.reduce((n, l) => n + l.amountCents, 0);
  const collected = lines.reduce((n, l) => n + l.collectedCents, 0);

  // 1. Billed and not collected. The commonest one, and the one with a date on it.
  const uncollected = billed - collected;
  if (uncollected > 0 && billed > 0) {
    leaks.push({
      kind: "uncollected",
      loadId,
      category: null,
      cents: uncollected,
      note: `${formatCents(uncollected)} billed and not yet collected on this load.`,
    });
  }

  // 2. The estimate said more than the ledger ever billed. Not proof of anything — the estimate
  //    could have been optimistic — which is why the note says "estimated" and not "owed".
  if (input.estimatedNetCents !== null && billed > 0) {
    const costs = lines.filter((l) => l.amountCents < 0).reduce((n, l) => n + -l.amountCents, 0);
    const actualNet = billed - costs;
    const gap = input.estimatedNetCents - actualNet;
    if (gap > 0) {
      leaks.push({
        kind: "underbilled",
        loadId,
        category: null,
        cents: gap,
        note: `The estimate was ${formatCents(gap)} above what the ledger records for this load. Worth checking why; it is not proof that anything is owed.`,
      });
    }
  }

  // 3. An accessorial agreed on the deal with no ledger line at all. Detention that was earned,
  //    agreed, and never billed is the leak this product exists to notice.
  const billedByCategory = new Map<string, number>();
  for (const l of revenue) billedByCategory.set(l.category, (billedByCategory.get(l.category) ?? 0) + l.amountCents);
  for (const [category, agreed] of Object.entries(input.agreedAccessorialsCents ?? {})) {
    const onLedger = billedByCategory.get(category) ?? 0;
    const short = agreed - onLedger;
    if (short > 0) {
      leaks.push({
        kind: "missing_accessorial",
        loadId,
        category,
        cents: short,
        note:
          onLedger === 0
            ? `${formatCents(short)} of agreed ${category} does not appear on the ledger at all.`
            : `${formatCents(short)} less ${category} was billed than the deal agreed.`,
      });
    }
  }

  return leaks;
}

/**
 * Integer cents to a display string. Formatted from the INTEGER, never via a float: the cents
 * are split off with `%` and `/`, so `2800` is "$28.00" because 2800 divided by 100 is 28 and
 * 2800 modulo 100 is 0 — not because a decimal was constructed and hoped to round well.
 */
export function formatCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`formatCents: expected integer cents, got ${cents}`);
  }
  const negative = cents < 0;
  const abs = negative ? -cents : cents;
  const dollars = (abs - (abs % 100)) / 100;
  const remainder = abs % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${String(remainder).padStart(2, "0")}`;
}
