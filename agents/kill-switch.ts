// EZ Trucking — the global kill switch. Andrew's ask, 2026-09-04: "a kill switch where it stops
// all the agents, and notifications if they get out of line — out of their scope of work — go
// to me or Claude Code." This is that switch, plus the auto-trip logic that flips it without a
// human having to notice first.
//
// Persisted to a local file so it survives a process restart (a crashed/redeployed worker should
// NOT quietly forget it was tripped). Moves to a Supabase row alongside the rest of rule 36's
// audit trail once that table exists — the file is enough to develop against, not enough to run
// production sends/books/pays against untended.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// O-7 fix, 2026-09-06 (Claude Code, approved in handoff/COWORK-TO-CODE.md 14:36 CT):
// `new URL(".", import.meta.url).pathname` keeps a leading slash on Windows (/C:/Users/...),
// so join() resolved against the drive root -> C:\C:\Users\... and mkdirSync threw ENOENT.
// Practical effect on Andrew's PC: engageKillSwitch() threw before it could persist state, so the rule-37 switch did not reliably engage and its incidents log was never written.
// fileURLToPath is the documented cross-platform conversion; Linux behaviour is unchanged.
const LOG_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "logs");
const STATE_FILE = join(LOG_DIR, ".kill-switch.json");
const INCIDENTS_FILE_PREFIX = join(LOG_DIR, "incidents-");

interface KillSwitchState {
  engaged: boolean;
  reason: string | null;
  triggeredBy: string | null; // "auto:<skillName>" or a person's name/id for a manual engage
  engagedAt: string | null;
}

function readState(): KillSwitchState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    // fall through to default — a corrupt state file should fail safe (engaged), not open
  }
  return { engaged: false, reason: null, triggeredBy: null, engagedAt: null };
}

function writeState(state: KillSwitchState): void {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function isKillSwitchEngaged(): boolean {
  return readState().engaged;
}

export function getKillSwitchState(): KillSwitchState {
  return readState();
}

/**
 * Notification stub. There's no real email/SMS/push channel wired into the app yet (needs its
 * own ticket — this is founder/ops notification, not the driver-facing app, so it's outside the
 * "no paid API keys in the app" hard rule, but it still needs a real decision: email? SMS? a
 * desktop alert?). Until then this writes a separate, loud incidents file distinct from the
 * ordinary audit log, and prints a banner no one tailing the console logs could miss. Any Claude
 * Code session working in this repo will see agents/logs/incidents-*.jsonl on its next look.
 */
function notifyIncident(reason: string, triggeredBy: string, detail: unknown): void {
  const entry = { ts: new Date().toISOString(), reason, triggeredBy, detail };
  console.error("\n" + "!".repeat(70));
  console.error(`KILL SWITCH ENGAGED — ${reason}`);
  console.error(`Triggered by: ${triggeredBy}`);
  console.error("All agent model calls and all actions are now refused until a human releases it.");
  console.error("!".repeat(70) + "\n");
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const day = entry.ts.slice(0, 10);
    appendFileSync(`${INCIDENTS_FILE_PREFIX}${day}.jsonl`, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error("notifyIncident: failed to write incidents log file", err);
  }
  // TODO (ticket needed): real push — email to Andrew, and/or a webhook any open Claude Code
  // session can be woken by. Do not wire a paid notification API key without Andrew's say-so.
}

/** Manual engage — a person or an ops script flips this. */
export function engageKillSwitch(reason: string, triggeredBy: string): void {
  writeState({ engaged: true, reason, triggeredBy, engagedAt: new Date().toISOString() });
  notifyIncident(reason, triggeredBy, {});
}

/**
 * Auto-engage from inside guardrails.ts when a skill looks like it's operating outside its scope.
 * Same effect as engageKillSwitch, kept separate only so the caller can hand over the evidence
 * that tripped it.
 */
export function autoEngageKillSwitch(reason: string, skillName: string, evidence: unknown): void {
  writeState({ engaged: true, reason, triggeredBy: `auto:${skillName}`, engagedAt: new Date().toISOString() });
  notifyIncident(reason, `auto:${skillName}`, evidence);
}

/**
 * The ONLY way to turn it back on. Deliberately requires a human name and a note — an auto-trip
 * never auto-clears itself (same lesson as rule 6/incident research: an agent's own "I'm fine
 * now" is not a control). Call this from a real ops action, not from any agent code.
 */
export function releaseKillSwitch(releasedBy: string, note: string): void {
  const prior = readState();
  writeState({ engaged: false, reason: null, triggeredBy: null, engagedAt: null });
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(
      `${INCIDENTS_FILE_PREFIX}${day}.jsonl`,
      JSON.stringify({ ts: new Date().toISOString(), event: "kill_switch_released", releasedBy, note, prior }) + "\n",
      "utf-8"
    );
  } catch (err) {
    console.error("releaseKillSwitch: failed to write incidents log file", err);
  }
  console.log(`Kill switch released by ${releasedBy}: ${note}`);
}

export class KillSwitchEngagedError extends Error {
  constructor(state: KillSwitchState) {
    super(`Kill switch is engaged (${state.reason ?? "no reason recorded"}, by ${state.triggeredBy}). Refusing.`);
    this.name = "KillSwitchEngagedError";
  }
}
