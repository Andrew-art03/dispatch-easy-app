/**
 * EZ-BUILD-01 Slice 6 (ticket 3A) — the load state machine, as pure data.
 *
 * PURE. No model import, no database client, no network, no environment, no clock
 * (BUILD_DEFAULTS §3, enforced by scripts/assert-domain-purity.mjs, whose self-test must go
 * red on a planted positive). Everything here is a function of its arguments.
 *
 * THIS IS NOT THE ENFORCEMENT. `transition_load()` in migration 0005 is, because it runs
 * inside the transaction that takes the row lock, and because `update (state) on load` is
 * revoked from authenticated and anon (0003) so nothing else can write the column at all.
 * This copy exists so the client can grey out a button and the server can explain a refusal
 * without a round trip — and tests/transition-load.test.ts parses the SQL and asserts the two
 * agree edge for edge, so the convenience copy cannot drift into a second, softer opinion.
 *
 * THE STATES ARE THE FROZEN SCHEMA'S, NOT MINE. `load_state` in supabase/schema.sql, in its
 * declared order. Nothing is added here; a new state is a migration and a ticket.
 */

export const LOAD_STATES = [
  "candidate_found",
  "qualified",
  "pursue_approved",
  "negotiating",
  "terms_proposed",
  "rate_con_received",
  "booked",
  "in_transit",
  "delivered",
  "billing_ready",
  "paid_reconciled",
  "learned",
  "rejected",
] as const;

export type LoadState = (typeof LOAD_STATES)[number];

/**
 * The legal edges, and why each one exists.
 *
 * The forward spine follows the enum's own declared order — that order is the artifact, not an
 * inference. Two things are NOT derivable from the enum and are written down as decisions so a
 * reviewer can disagree with them in one place:
 *
 *   1. `rejected` is reachable from every pre-transit state. A load can be dropped at any point
 *      before the truck is loaded, and the reason belongs in the event row, not in a new state.
 *
 *   2. `booked -> rejected` is the TONU / fell-through path, and it is the one edge here I am
 *      least sure of. The frozen enum has no `cancelled`, so `rejected` is the only terminal
 *      that is not a completion. TODO(3B/spec): if a booked load that dies needs to be
 *      distinguishable from one that was never pursued — and for TONU accounting it probably
 *      does — that is a `cancelled` state, which is a schema change and therefore a ticket.
 *      Until then this edge exists and the event row carries the reason.
 *
 * Nothing after `in_transit` may be rejected. Once the freight is moving, the outcome is
 * delivered-and-billed or an exception handled outside this machine; quietly marking a moving
 * load `rejected` would lose a real obligation.
 *
 * There are no self-edges. `x -> x` is not a transition, and treating it as one is how a
 * double-tap writes a second event for an action that happened once.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<LoadState, readonly LoadState[]>> = {
  candidate_found: ["qualified", "rejected"],
  qualified: ["pursue_approved", "rejected"],
  pursue_approved: ["negotiating", "rejected"],
  // A broker can come back with terms, or the negotiation can die.
  negotiating: ["terms_proposed", "rejected"],
  // Terms can be countered, which is a return to negotiating rather than a new state.
  terms_proposed: ["rate_con_received", "negotiating", "rejected"],
  // The rate con arrived. It still has to match what was agreed before anything is booked —
  // that check is 4A/3B's, and this machine only says the edge is legal.
  rate_con_received: ["booked", "rejected"],
  booked: ["in_transit", "rejected"],
  in_transit: ["delivered"],
  delivered: ["billing_ready"],
  billing_ready: ["paid_reconciled"],
  paid_reconciled: ["learned"],
  // Terminal.
  learned: [],
  rejected: [],
};

export const TERMINAL_STATES: readonly LoadState[] = LOAD_STATES.filter(
  (s) => LEGAL_TRANSITIONS[s].length === 0,
);

export function isLoadState(value: unknown): value is LoadState {
  return typeof value === "string" && (LOAD_STATES as readonly string[]).includes(value);
}

export interface TransitionRefusal {
  readonly ok: false;
  readonly reason: "unknown_from" | "unknown_to" | "terminal" | "illegal";
  /** Safe to show a user: names states, never ids, never another tenant's anything. */
  readonly message: string;
}

export type TransitionCheck = { readonly ok: true } | TransitionRefusal;

/**
 * Is `from -> to` legal? Pure, total, and it never throws — a caller that has to wrap a
 * legality check in a try/catch will eventually catch something it did not mean to.
 */
export function canTransition(from: unknown, to: unknown): TransitionCheck {
  if (!isLoadState(from)) {
    return { ok: false, reason: "unknown_from", message: `${String(from)} is not a load state` };
  }
  if (!isLoadState(to)) {
    return { ok: false, reason: "unknown_to", message: `${String(to)} is not a load state` };
  }
  if (LEGAL_TRANSITIONS[from].length === 0) {
    return { ok: false, reason: "terminal", message: `${from} is terminal; nothing follows it` };
  }
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      reason: "illegal",
      message: `${from} -> ${to} is not a legal transition; from ${from} the load may go to ${LEGAL_TRANSITIONS[from].join(", ")}`,
    };
  }
  return { ok: true };
}

/** Every legal edge, flattened. Used by the test that compares this file to the migration. */
export function allEdges(): readonly (readonly [LoadState, LoadState])[] {
  return LOAD_STATES.flatMap((from) => LEGAL_TRANSITIONS[from].map((to) => [from, to] as const));
}

/**
 * The event `type` written for a transition. One shape, so a later reader can find every state
 * change with a single prefix match rather than a list of verbs that grew over time.
 */
export function transitionEventType(to: LoadState): string {
  return `state.${to}`;
}
