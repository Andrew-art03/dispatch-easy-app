/**
 * EZ-BUILD-01 Slice 4 (ticket 2D) — "authenticated" is not "allowed".
 *
 * SPEC 2D's capability list, and the role matrix that answers it. Two entries in that list are
 * deliberately granted to NOBODY, and those two are the interesting part of this file:
 *
 *   `admin.kill_switch` — the rule-37 switch is the founder's, and the founder is
 *      `is_founder()` in the database: a pinned `auth.users.id` AND an `app_metadata` flag,
 *      both of which must hold. It is NOT `user.role = 'owner'`. Every carrier that signs up
 *      is an owner of their own org; if owner carried this capability, every customer could
 *      disable the platform's safety switch. SPEC 2D names this as a test in its own right.
 *
 *   `ledger.write` — money is written by `execute_approved_action` after `consume_approval`,
 *      and `insert on ledger_line` is revoked from authenticated, anon and service_role alike
 *      (migration 0003). There is no role for which "may write a ledger line" is true, so the
 *      capability exists to be refused rather than to be granted. It stays in the list because
 *      a capability that does not exist cannot be checked for, and a future handler asking for
 *      it should get a 403 rather than an "unknown capability" crash.
 *
 * A capability answers "may this role ask?". It never answers "may this row be touched?" —
 * that is RLS, in the database, and it is enforced whatever this file says.
 */
import { HttpError, type RequestContext, type Role } from "./context.ts";

export type Capability =
  | "load.read"
  | "load.create"
  | "load.transition"
  | "deal.approve"
  | "document.upload"
  | "document.read"
  | "call.confirm"
  | "ledger.write"
  | "admin.kill_switch";

export const CAPABILITIES: readonly Capability[] = [
  "load.read",
  "load.create",
  "load.transition",
  "deal.approve",
  "document.upload",
  "document.read",
  "call.confirm",
  "ledger.write",
  "admin.kill_switch",
];

export const ROLE_CAPS: Record<Role, readonly Capability[]> = {
  // The carrier. Everything about their own loads, and nothing about the platform.
  owner: [
    "load.read",
    "load.create",
    "load.transition",
    "deal.approve",
    "document.upload",
    "document.read",
    "call.confirm",
  ],
  // Works loads on the carrier's behalf. Same day-to-day surface as the owner for now; the
  // split that matters in this pilot is owner/dispatcher vs driver, not owner vs dispatcher.
  dispatcher: [
    "load.read",
    "load.create",
    "load.transition",
    "deal.approve",
    "document.upload",
    "document.read",
    "call.confirm",
  ],
  // Rule 16: no interactive flow is designed for use while operating, and driving mode is
  // read-only. A driver reads loads, sends documents, and confirms by voice in one word
  // (rule 34). `load.transition` is NOT here: moving a load's state is a decision, and a
  // decision made at 65 mph is the thing rule 16 exists to prevent. If detention start needs
  // to be a driver action, that is a deliberate ticket, not a quiet addition to this array.
  driver: ["load.read", "document.upload", "document.read", "call.confirm"],
};

/** Capabilities granted to no role at all, by design. Asserted, so it cannot drift silently. */
export const GRANTED_TO_NOBODY: readonly Capability[] = ["ledger.write", "admin.kill_switch"];

export function hasCapability(ctx: RequestContext, cap: Capability): boolean {
  return (ROLE_CAPS[ctx.role] ?? []).includes(cap);
}

/** Throws 403 when the role does not carry the capability. */
export function requireCapability(ctx: RequestContext, cap: Capability): void {
  if (!hasCapability(ctx, cap)) {
    // The message names the capability and the role, and never the org or the user id: a 403
    // body is the one place a caller learns about the system, so it learns as little as
    // possible (rule 6).
    throw new HttpError(403, `role ${ctx.role} lacks ${cap}`, "Not permitted.");
  }
}
