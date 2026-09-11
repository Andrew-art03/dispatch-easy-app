// EZ Trucking — the sandbox. Every model call in the app goes through runAgentTask().
// Walls: schema (§1), authority (§2), runaway (§2.5, rule 31), kill switch (§2.6), action (§3, in
// actions.ts). See agents/README.md for the plain-English version, and
// HQ/24-AGENT-INCIDENT-LESSONS.md for why each wall exists — every one traces to a real,
// documented AI-agent incident.

import { z } from "zod";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAST, MONEY, type Lane } from "./models";
import { isKillSwitchEngaged, autoEngageKillSwitch, KillSwitchEngagedError } from "./kill-switch";

interface RunAgentTaskArgs<TSchema extends z.ZodTypeAny> {
  lane: Lane;
  skillName: string;           // matches a skills/<skillName>/SKILL.md — for logging/audit only
  systemPrompt: string;        // from the SKILL.md, loaded by the caller
  userInput: unknown;          // whatever facts the skill is allowed to see — never raw driver text unfiltered
  schema: TSchema;             // the JSON shape the model MUST fill — nothing else gets through; every
                                // skill schema should be .strict() so an unexpected field is a rejection,
                                // not silently dropped — an out-of-scope field IS the scope violation.
  codeTruth?: Record<string, unknown>; // §2: numbers the calculator already computed; model explains, never overrides
  fallback: z.infer<TSchema>;  // §1: what the driver sees if the model's output fails validation
  sessionId?: string;          // rule 31: which runaway-loop bucket this call counts against; defaults to "unscoped"
}

interface AgentResult<T> {
  ok: boolean;
  data: T;           // validated model output OR the fallback — always safe to render
  usedFallback: boolean;
  mismatch?: { field: string; codeValue: unknown; modelValue: unknown }[]; // §2 disagreements, logged not shown
}

// ---------------------------------------------------------------------------
// Rule 31 — hard, code-enforced ceiling per session, not a dashboard someone has
// to notice. Direct fix for the 264-hour / $47,000 LangChain loop in
// HQ/24-AGENT-INCIDENT-LESSONS.md Part D.
// ---------------------------------------------------------------------------
const MAX_CALLS_PER_SESSION = 200;
const MAX_TOKENS_PER_SESSION = 500_000;

interface SessionUsage {
  calls: number;
  tokens: number;
}
const sessionUsage = new Map<string, SessionUsage>();

class RunawayGuardError extends Error {
  constructor(sessionId: string, usage: SessionUsage) {
    super(
      `Rule 31 stop: session "${sessionId}" hit its ceiling (${usage.calls} calls / ${usage.tokens} tokens). ` +
        `Refusing further model calls in this session rather than looping unattended.`
    );
    this.name = "RunawayGuardError";
  }
}

// ---------------------------------------------------------------------------
// §2.6 KILL SWITCH auto-trip — Andrew's ask, 2026-09-04: stop ALL agents and notify him/Claude
// Code the moment one looks like it's operating outside its scope. "Outside its scope" here means
// two concrete, code-detectable things: (a) its output kept failing the schema wall — including an
// unexpected field a .strict() schema now catches, which is exactly what an agent trying to do
// something it wasn't asked to would look like; or (b) it kept trying to override numbers code
// already computed. Three in a row, for one skill, trips the switch for every skill — see
// kill-switch.ts for why a trip never auto-clears itself.
// ---------------------------------------------------------------------------
const CONSECUTIVE_VIOLATION_LIMIT = 3;
const consecutiveViolations = new Map<string, number>();

function recordViolation(skillName: string, kind: "schema_reject" | "code_truth_override", evidence: unknown): void {
  const count = (consecutiveViolations.get(skillName) ?? 0) + 1;
  consecutiveViolations.set(skillName, count);
  if (count >= CONSECUTIVE_VIOLATION_LIMIT) {
    autoEngageKillSwitch(
      `Skill "${skillName}" hit ${count} consecutive ${kind} events — looks out of scope, not just unlucky.`,
      skillName,
      evidence
    );
  }
}

function recordSuccess(skillName: string): void {
  consecutiveViolations.set(skillName, 0);
}

export async function runAgentTask<TSchema extends z.ZodTypeAny>(
  args: RunAgentTaskArgs<TSchema>
): Promise<AgentResult<z.infer<TSchema>>> {
  if (isKillSwitchEngaged()) {
    await auditLog(args.skillName, "kill_switch_refused_call", {});
    throw new KillSwitchEngagedError({ engaged: true, reason: null, triggeredBy: null, engagedAt: null });
  }

  const cfg = args.lane === "fast" ? FAST : MONEY;
  const sessionId = args.sessionId ?? "unscoped";

  const usage = sessionUsage.get(sessionId) ?? { calls: 0, tokens: 0 };
  if (usage.calls >= MAX_CALLS_PER_SESSION || usage.tokens >= MAX_TOKENS_PER_SESSION) {
    await auditLog(args.skillName, "runaway_guard_tripped", { sessionId, usage });
    throw new RunawayGuardError(sessionId, usage);
  }

  // §1 SCHEMA WALL — ask the model to fill exactly this shape, nothing else.
  const { raw, tokensUsed } = await callModel(cfg, args.systemPrompt, args.userInput, args.schema);

  usage.calls += 1;
  usage.tokens += tokensUsed;
  sessionUsage.set(sessionId, usage);

  const parsed = args.schema.safeParse(raw);

  if (!parsed.success) {
    await auditLog(args.skillName, "schema_reject", { sessionId, raw, issues: parsed.error.issues });
    recordViolation(args.skillName, "schema_reject", { raw, issues: parsed.error.issues });
    return { ok: false, data: args.fallback, usedFallback: true };
  }

  // §2 AUTHORITY WALL — if code already computed a number, the model may only explain it.
  // Any field the model tried to override that also exists in codeTruth loses, silently to the
  // driver, loudly to the log.
  const mismatch: AgentResult<unknown>["mismatch"] = [];
  const data = { ...parsed.data } as Record<string, unknown>;
  if (args.codeTruth) {
    for (const [field, truth] of Object.entries(args.codeTruth)) {
      if (field in data && data[field] !== truth) {
        mismatch.push({ field, codeValue: truth, modelValue: data[field] });
        data[field] = truth; // code wins, always
      }
    }
  }
  if (mismatch.length) {
    await auditLog(args.skillName, "code_truth_override", { sessionId, mismatch });
    recordViolation(args.skillName, "code_truth_override", { mismatch });
  } else {
    recordSuccess(args.skillName);
  }

  await auditLog(args.skillName, "call_ok", { sessionId, usedFallback: false });
  return { ok: true, data: data as z.infer<TSchema>, usedFallback: false, mismatch };
}

// ---------------------------------------------------------------------------
// Rule 32 — any task asking for N outputs is verified by counting the actual
// outputs in code, never accepted on the model's own "done" claim.
// ---------------------------------------------------------------------------
export function assertExpectedCount<T>(items: T[], expected: number, label: string): T[] {
  if (items.length !== expected) {
    throw new Error(
      `Rule 32 stop: expected ${expected} ${label}, got ${items.length}. ` +
        `Not accepting the model's own claim that this batch is complete.`
    );
  }
  return items;
}

// ---------------------------------------------------------------------------
// Rule 33 — in any multi-step action chain, a later step is structurally blocked
// from running before its prerequisite check has actually returned a result.
// ---------------------------------------------------------------------------
export function assertPrerequisite(satisfied: boolean, description: string): void {
  if (!satisfied) {
    throw new Error(`Rule 33 stop: prerequisite not met — ${description}. Refusing to proceed to the next step.`);
  }
}

// §3 ACTION WALL — deliberately NOT exported for model use from this file. actions.ts is the only
// place send/book/pay live, every one requiring a HumanApproval token and checking the kill switch
// itself too (defense in depth — see actions.ts).

async function callModel(
  cfg: { baseURL: string; authToken: string; model: string },
  systemPrompt: string,
  userInput: unknown,
  schema: z.ZodTypeAny
): Promise<{ raw: unknown; tokensUsed: number }> {
  // Anthropic-shaped request works against both Ollama (it speaks the same API surface,
  // see 06-AGENT-REGISTRY "one code path, two brains") and api.anthropic.com.
  const res = await fetch(`${cfg.baseURL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.authToken,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 512,
      system: systemPrompt + "\n\nRespond with JSON only, matching the required shape. No prose.",
      messages: [{ role: "user", content: JSON.stringify(userInput) }],
    }),
  });
  if (!res.ok) throw new Error(`Model call failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const text = body?.content?.[0]?.text ?? "";
  const tokensUsed = (body?.usage?.input_tokens ?? 0) + (body?.usage?.output_tokens ?? 0);
  try {
    return { raw: JSON.parse(text), tokensUsed };
  } catch {
    return { raw: text, tokensUsed }; // let schema.safeParse fail it cleanly rather than throwing here
  }
}

// ---------------------------------------------------------------------------
// Rule 36 — real, replayable audit record for every model call. Local append-only file until the
// Supabase audit_log table exists; still release-blocking for send/book/pay until then.
// ---------------------------------------------------------------------------
// O-7 fix, 2026-09-06 (Claude Code, approved in handoff/COWORK-TO-CODE.md 14:36 CT):
// `new URL(".", import.meta.url).pathname` keeps a leading slash on Windows (/C:/Users/...),
// so join() resolved against the drive root -> C:\C:\Users\... and mkdirSync threw ENOENT.
// Practical effect on Andrew's PC: auditLog() silently failed to write the rule-36 JSONL trail.
// fileURLToPath is the documented cross-platform conversion; Linux behaviour is unchanged.
const LOG_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "logs");

async function auditLog(skillName: string, event: string, detail: unknown): Promise<void> {
  const entry = { ts: new Date().toISOString(), skillName, event, detail };
  console.log(JSON.stringify(entry));
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const day = entry.ts.slice(0, 10); // YYYY-MM-DD
    appendFileSync(join(LOG_DIR, `audit-${day}.jsonl`), JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error("auditLog: failed to write local log file", err);
  }
}
