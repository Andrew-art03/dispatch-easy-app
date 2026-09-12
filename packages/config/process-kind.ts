/**
 * Process identity — TICKET 1F item 1 (ChatGPT panel finding C-2).
 *
 * THE DEFECT THIS FIXES. 1B decided `agent | app | edge` from
 * `EZ_PROCESS_KIND`, an ordinary environment variable, defaulting to `agent`
 * when unset. That default fails safe against *forgetting*; it does nothing
 * against *setting*. `EZ_PROCESS_KIND=app` in an inherited environment, a
 * launcher, a CI matrix or a test harness turned rule 40's check in `db.ts`
 * off — the one check whose entire purpose is that an agent process can never
 * hold a production client. Four reviewers read 1B and none of us asked who
 * sets the variable that decides whether the kill switch runs.
 *
 * THE FIX, and why this shape. The ticket offered two options: derive the kind
 * from the entrypoint/build artifact, or keep the variable for the app/edge
 * opt-out and add an agent-side deny that no environment value can disable.
 * Option (a) alone is not available yet — the agents are not a separate build
 * artifact in this repo, they are `agents/*.ts` run in place, so there is no
 * bundle to stamp a build constant into. So: option (b), with the entrypoint
 * half of option (a) added as a second, independent leg.
 *
 *   Leg A — explicit declaration. `agents/agent-process.ts` calls
 *   `declareProcessKind("agent", …)` at module init, and every agent runtime
 *   module imports it. Loading any agent code declares the process.
 *
 *   Leg B — entrypoint inference. If the file this process was started with
 *   lives under `agents/`, the process IS an agent, whatever it did or did not
 *   import. Covers `bun agents/whatever.ts` when leg A was forgotten.
 *
 * Both legs are DENY-ONLY: they can assert `agent`, never `app` or `edge`, so
 * neither can ever be used to widen access. Neither is reachable from the
 * environment — `argv[1]` is not an env var, and a declaration is a function
 * call in our own source. Either one overrides `EZ_PROCESS_KIND`, and a
 * contradiction between them and the variable trips the kill switch rather than
 * resolving to anything.
 *
 * WHAT THIS DOES NOT CLAIM. Leg A depends on agent modules importing the
 * declaration, which is a convention CI enforces (`check:agent-imports`), not a
 * structural impossibility. Leg B does not depend on it, which is why both
 * exist — but an agent entrypoint placed outside `agents/` and importing no
 * agent module is covered by neither. The honest statement of the guarantee is
 * "no env value can turn the agent deny off", not "nothing can ever be
 * mistaken for an app".
 */

import { killSwitchTrip } from "./kill-switch.ts";

export type ProcessKind = "agent" | "app" | "edge";

/** Where an effective kind came from. Ordered by precedence, highest first. */
export type KindSource = "declared" | "entrypoint" | "env" | "default";

let declared: ProcessKind | undefined;
let declaredBy: string | undefined;

/**
 * Declare what this process is, from code. Idempotent for the same kind; a
 * contradicting second declaration is a trip, not a last-write-wins — a process
 * does not change identity halfway through, so a second, different answer means
 * either a bug or something trying on a smaller hat.
 *
 * `source` is a module path for the error message. It is never a secret and
 * never user input.
 */
export function declareProcessKind(kind: ProcessKind, source: string): void {
  if (declared !== undefined && declared !== kind) {
    killSwitchTrip(
      "process_kind",
      `process already declared "${declared}" by ${declaredBy}; ${source} now declares "${kind}"`,
    );
  }
  declared = kind;
  declaredBy ??= source;
}

/** The explicit declaration, if any code has made one. */
export function declaredProcessKind(): ProcessKind | undefined {
  return declared;
}

/** Who made it. Used only to make a contradiction message nameable. */
export function declaredProcessKindSource(): string | undefined {
  return declaredBy;
}

/**
 * Leg B. `agents/` in the entry path means agent, full stop; anything else
 * means "no opinion" — never "app". Guarded on every access: `process` does not
 * exist in the browser bundle, and `argv` is not guaranteed to be an array.
 *
 * Matched on a path SEGMENT (`/agents/`), not a substring, so `src/reagents/`
 * or a directory called `myagents` does not accidentally claim agenthood. A
 * false positive here is only ever more restrictive, but a rule nobody can
 * predict is worse than a rule that is slightly narrow.
 */
export function entrypointProcessKind(): ProcessKind | undefined {
  const proc = (globalThis as { process?: { argv?: unknown } }).process;
  const argv = proc?.argv;
  if (!Array.isArray(argv)) return undefined;
  const entry = argv[1];
  if (typeof entry !== "string" || entry === "") return undefined;
  const normalised = entry.replace(/\\/g, "/");
  return /(^|\/)agents\//.test(normalised) ? "agent" : undefined;
}

/**
 * The kind this process can be proven to be without consulting the
 * environment at all, and where that proof came from. `undefined` means no
 * code-level evidence either way — only then may `EZ_PROCESS_KIND` decide.
 */
export function provenProcessKind(): { kind: ProcessKind; source: KindSource } | undefined {
  if (declared !== undefined) return { kind: declared, source: "declared" };
  const inferred = entrypointProcessKind();
  if (inferred !== undefined) return { kind: inferred, source: "entrypoint" };
  return undefined;
}

/** Test-only. Drops the declaration so a case can start from a clean process. */
export function resetDeclaredProcessKind(): void {
  declared = undefined;
  declaredBy = undefined;
}
