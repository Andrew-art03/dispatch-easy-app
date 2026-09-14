// Real, permanent test file — not a smoke script that gets deleted after the fact.
// Answers Perplexity's review directly: "self-reported... not verified until test artifacts
// exist." Covers the parts of the action/kill-switch wall that don't require a live model call
// or a real database (those are the DB-backed audit log + two-account isolation suite still
// owed — see HQ/24-AGENT-INCIDENT-LESSONS.md's release-blocking checklist).
//
// 1E-M (2026-09-11): copied from EZ-Trucking-HQ/agents/wall.test.ts and ported 1:1 from
// `node:test` + `node:assert/strict` to vitest, because the app repo's `bun run test` is
// vitest and a node:test file would silently never run here. Every case and every regex is
// unchanged; only the assertion API moved. The HQ original is untouched until this merges.
//
// Run: bun run test   (vitest picks up **/*.test.ts, so this file runs in place)

import { describe, expect, it } from "vitest";
import { assertExpectedCount, assertPrerequisite } from "./guardrails";
import { confirmHumanApproval, sendBrokerMessage, bookLoad, initiatePayment } from "./actions";
import { engageKillSwitch, releaseKillSwitch, isKillSwitchEngaged } from "./kill-switch";

describe("agents wall (rules 32/33/35/36/37)", () => {
  it("rule 32: assertExpectedCount throws on a short batch, passes on an exact one", () => {
    expect(() => assertExpectedCount([1, 2, 3], 5, "week-routes")).toThrow(/Rule 32 stop/);
    expect(assertExpectedCount([1, 2], 2, "x")).toEqual([1, 2]);
  });

  it("rule 33: assertPrerequisite throws when the prerequisite isn't satisfied", () => {
    expect(() => assertPrerequisite(false, "availability not checked")).toThrow(/Rule 33 stop/);
    expect(() => assertPrerequisite(true, "checked")).not.toThrow();
  });

  it("action wall: sendBrokerMessage refuses without a HumanApproval token", async () => {
    await expect(
      // @ts-expect-error deliberately omitting approval — this is the hostile path, not a typo
      sendBrokerMessage({ orgId: "org1", loadId: "load1", brokerContactId: "b1", message: "hi" }),
    ).rejects.toThrow(/no HumanApproval token supplied/);
  });

  it("action wall: bookLoad refuses without a carrier MC number even with approval (rule 35)", async () => {
    const approval = confirmHumanApproval({ approvedBy: "driver-1", source: "tap" });
    await expect(
      // @ts-expect-error deliberately omitting carrierMcNumber
      bookLoad({ approval, orgId: "org1", loadId: "load1" }),
    ).rejects.toThrow(/rule 35/);
  });

  it("action wall: a real approval token reaches the not-implemented stop, proving the wall passes and only the implementation is missing", async () => {
    const approval = confirmHumanApproval({ approvedBy: "driver-1", source: "tap" });
    await expect(
      sendBrokerMessage({ approval, orgId: "org1", loadId: "load1", brokerContactId: "b1", message: "hi" }),
    ).rejects.toThrow(/not implemented yet/);
    await expect(
      initiatePayment({ approval, orgId: "org1", amountCents: 500, reason: "test" }),
    ).rejects.toThrow(/not implemented yet/);
  });

  it("kill switch: engaging blocks every action wall function; release un-blocks it", async () => {
    expect(isKillSwitchEngaged(), "precondition: switch should start released").toBe(false);
    const approval = confirmHumanApproval({ approvedBy: "driver-1", source: "tap" });

    engageKillSwitch("test trip", "wall.test.ts");
    expect(isKillSwitchEngaged()).toBe(true);
    await expect(
      sendBrokerMessage({ approval, orgId: "org1", loadId: "load1", brokerContactId: "b1", message: "hi" }),
    ).rejects.toThrow(/Kill switch is engaged/);
    await expect(
      bookLoad({ approval, orgId: "org1", loadId: "load1", carrierMcNumber: "MC123" }),
    ).rejects.toThrow(/Kill switch is engaged/);

    releaseKillSwitch("wall.test.ts", "clearing test trip");
    expect(isKillSwitchEngaged()).toBe(false);
    // and a normal call now reaches its usual not-implemented stop again, proving release actually works
    await expect(
      sendBrokerMessage({ approval, orgId: "org1", loadId: "load1", brokerContactId: "b1", message: "hi" }),
    ).rejects.toThrow(/not implemented yet/);
  });
});

// NOT covered here, on purpose — flagged rather than silently skipped:
// - Kill-switch AUTO-trip on 3 consecutive schema/authority violations (rule 37) requires a live
//   model call through runAgentTask(); needs either a mock model server or an exported test hook,
//   neither of which exists yet. Next ticket.
// - Two-account tenant isolation (rule 12's named gate) requires a real database with two org
//   rows and RLS — cannot be tested against agents/ alone. Still owed per the release checklist.
// - Wrong-org / wrong-actor rejection requires real auth context this folder doesn't have yet.
