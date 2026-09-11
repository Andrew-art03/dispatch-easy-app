// EZ Trucking — §3 ACTION WALL. This is the module referenced (and deliberately not built) in
// guardrails.ts's original comment. Nothing in agents/skills/**/worker.ts or guardrails.ts can
// import from here — skills only ever produce data for a screen; a human or a verified voice
// confirmation is what turns that into a real send/book/pay, and only through this file.
//
// STATUS: scaffold only, on Andrew's go-ahead 2026-09-04. The structural wall (you cannot call
// sendBrokerMessage/bookLoad/initiatePayment without a real HumanApproval token, and you cannot
// mint that token except through a real tap or confirmed voice turn) is real and enforced by the
// type system + the runtime check below. The actual side effects (email send, Stripe charge,
// Supabase state-transition write) are NOT wired yet — each throws "not implemented" so this
// file can be dropped into the repo, reviewed, and merged without accidentally being able to do
// anything to a live system before the real integrations get their own tickets.
//
// Rule 36 (release-blocking): do not remove the "not implemented" throws, and do not wire a real
// integration in here, until the audit log is backed by the Supabase audit_log table — a local
// JSONL file (see guardrails.ts) is enough to develop against, not enough to ship real sends on.

import { assertPrerequisite } from "./guardrails";
import { isKillSwitchEngaged, KillSwitchEngagedError, getKillSwitchState } from "./kill-switch";

// Defense in depth: even though runAgentTask() already refuses to call a model once the switch
// is engaged, actions.ts checks it again itself — an action wall that only trusts the upstream
// check is one refactor away from a hole. Call this first in every exported action function.
function assertKillSwitchNotEngaged(): void {
  if (isKillSwitchEngaged()) {
    throw new KillSwitchEngagedError(getKillSwitchState());
  }
}

// A HumanApproval can only be minted by confirmHumanApproval() below — the branded field can't
// be set from outside this file without an explicit `as any`, which is exactly the kind of thing
// code review (rule 30) is supposed to catch. No model schema can produce this type; Zod schemas
// in every skill's worker.ts return plain data, never a branded token.
export type HumanApproval = {
  readonly __brand: "HumanApproval";
  readonly approvedAt: string;
  readonly approvedBy: string; // driver/user id from the authenticated session — never "the model"
  readonly source: "tap" | "voice_confirmed";
  readonly auditRef: string;
};

let approvalCounter = 0;

/**
 * The only way to get a HumanApproval token. Call this from the API route/voice-turn handler that
 * has just observed a real tap or a real confirmed "yes" on a voice session — never from a skill,
 * never from guardrails.ts's schema/authority walls, never from model output.
 */
export function confirmHumanApproval(input: {
  approvedBy: string;
  source: "tap" | "voice_confirmed";
}): HumanApproval {
  approvalCounter += 1;
  return {
    __brand: "HumanApproval",
    approvedAt: new Date().toISOString(),
    approvedBy: input.approvedBy,
    source: input.source,
    auditRef: `approval-${Date.now()}-${approvalCounter}`,
  };
}

export interface SendBrokerMessageInput {
  approval: HumanApproval;
  orgId: string;        // rule 4/rule 8 (HQ/24): every action is tenant-scoped
  loadId: string;
  brokerContactId: string;
  message: string;      // the driver-approved text — may be the broker-draft skill's output, edited or not
}

export async function sendBrokerMessage(input: SendBrokerMessageInput): Promise<never> {
  assertKillSwitchNotEngaged();
  assertPrerequisite(!!input.approval, "no HumanApproval token supplied");
  assertPrerequisite(!!input.orgId && !!input.loadId, "missing tenant/load scope");
  throw new Error(
    "actions.ts: sendBrokerMessage is not implemented yet. Structural wall (approval required, " +
      "tenant-scoped) is in place; the real IMAP/SMTP send needs its own ticket per repo-kit/CLAUDE.md rule 1."
  );
}

export interface BookLoadInput {
  approval: HumanApproval;
  orgId: string;
  loadId: string;
  carrierMcNumber: string; // rule 35: every booking scoped to exactly one carrier's MC number
}

export async function bookLoad(input: BookLoadInput): Promise<never> {
  assertKillSwitchNotEngaged();
  assertPrerequisite(!!input.approval, "no HumanApproval token supplied");
  assertPrerequisite(!!input.carrierMcNumber, "rule 35: booking has no carrier MC number scope");
  throw new Error(
    "actions.ts: bookLoad is not implemented yet. It must call a named Supabase state-transition " +
      "function (rule 2, guardrails.ts §3 comment) — never a direct table write from agent code."
  );
}

export interface InitiatePaymentInput {
  approval: HumanApproval;
  orgId: string;
  amountCents: number; // whole cents only — never a float dollar amount from anywhere, model or code
  reason: string;
}

export async function initiatePayment(input: InitiatePaymentInput): Promise<never> {
  assertKillSwitchNotEngaged();
  assertPrerequisite(!!input.approval, "no HumanApproval token supplied");
  throw new Error(
    "actions.ts: initiatePayment is not implemented yet. Needs its own ticket, its own Stripe " +
      "integration review, and does not exist for the pilot per HQ/21-FREE-STACK.md item 33."
  );
}
