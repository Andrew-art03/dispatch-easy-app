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
 *   `declareAgentProcess(…)` at module init, and every agent runtime
 *   module imports it. Loading any agent code declares the process.
 *
 *   Leg B — entrypoint inference. If the file this process was started with
 *   lives under `agents/`, the process IS an agent, whatever it did or did not
 *   import. Covers `bun agents/whatever.ts` when leg A was forgotten.
 *
 * Both legs are DENY-ONLY: they can assert `agent`, never `app` or `edge`, so
 * neither can ever be used to widen access. Neither is reachable from the
 * environment — `argv[1]` is not an env var, and a declaration is a function
 * call in our own source. Either one overrides `EZ_PROCESS_KIND`.
 *
 * 1F/N-4: that paragraph was a COMMENT, not a fact. Leg A was
 * `declareProcessKind(kind, source)` and it accepted `"app"`, and a declaration
 * SHADOWED Leg B instead of being reconciled with it — so `bun agents/run.ts`
 * resolved `agent` under 1B and under Leg B, but `app` if anything in its import
 * graph declared `"app"`. A path where the new code was LESS restrictive than
 * the env-var-only code it replaced, reached through code rather than the
 * environment, which is the one thing C-2's design was supposed to rule out.
 *
 * Leg A is now `declareAgentProcess(source)`. There is no kind parameter, so
 * "deny-only" is a property of the signature rather than a promise in a comment,
 * and `provenProcessKind()` answers `agent` when EITHER leg says so.
 *
 * WHAT THIS DOES NOT CLAIM. Leg A depends on agent modules importing the
 * declaration, which is a convention CI enforces (`check:agent-imports`), not a
 * structural impossibility. Leg B does not depend on it, which is why both
 * exist — but an agent entrypoint placed outside `agents/` and importing no
 * agent module is covered by neither. The honest statement of the guarantee is
 * "no env value can turn the agent deny off", not "nothing can ever be
 * mistaken for an app".
 */

export type ProcessKind = "agent" | "app" | "edge";

/** Where an effective kind came from. Ordered by precedence, highest first. */
export type KindSource = "declared" | "entrypoint" | "env" | "default";

let declared: ProcessKind | undefined;
let declaredBy: string | undefined;

/**
 * Declare this process an agent, from code. The ONLY declaration there is
 * (1F/N-4): there is no kind parameter, so no call site can declare `app` or
 * `edge`, and no amount of laundering through an intermediary can either.
 *
 * Idempotent — several agent modules import `agents/agent-process.ts` and every
 * one of them arrives here. The first caller's `source` is kept, because what a
 * later message wants to name is the module that established the identity.
 *
 * The old signature took a kind and tripped the kill switch on a contradicting
 * redeclaration. Both are gone: with `agent` the only value, the contradiction
 * it guarded against is not expressible, and a guard against an impossible
 * state is a guard nobody will maintain correctly.
 *
 * `source` is a module path for an error message. It is never a secret and
 * never user input.
 */
export function declareAgentProcess(source: string): void {
  declared = "agent";
  declaredBy ??= source;
}

/** The explicit declaration, if any code has made one. */
export function declaredProcessKind(): ProcessKind | undefined {
  return declared;
}

/** Who made it. Used only to make a message about the declaration nameable. */
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
 *
 * 1F/N-4: matched case-INSENSITIVELY. This repo lives on Windows, where NTFS is
 * case-insensitive — a launcher, a shortcut or a hand-typed `Agents\run.ts`
 * reaches exactly the same files, and the deny leg silently did not apply to
 * the process it was written for. The segment requirement is what keeps this
 * narrow; the case requirement was never doing any work, and on the platform
 * the build actually runs on it was doing harm.
 */
export function entrypointProcessKind(): ProcessKind | undefined {
  const proc = (globalThis as { process?: { argv?: unknown } }).process;
  const argv = proc?.argv;
  if (!Array.isArray(argv)) return undefined;
  const entry = argv[1];
  if (typeof entry !== "string" || entry === "") return undefined;
  const normalised = entry.replace(/\\/g, "/");
  return /(^|\/)agents\//i.test(normalised) ? "agent" : undefined;
}

/**
 * The kind this process can be proven to be without consulting the
 * environment at all, and where that proof came from. `undefined` means no
 * code-level evidence either way — only then may `EZ_PROCESS_KIND` decide.
 */
export function provenProcessKind(): { kind: ProcessKind; source: KindSource } | undefined {
  // 1F/N-4: an OR across the two legs, not a short-circuit on the first. Both
  // can only ever say `agent`, so combining them can only ever be MORE
  // restrictive — which is the property that makes reading them in either order
  // safe. The old version returned whatever `declared` held, so a declaration
  // could overrule the entrypoint downwards; this one cannot.
  const inferred = entrypointProcessKind();
  if (declared === "agent") return { kind: "agent", source: "declared" };
  if (inferred === "agent") return { kind: "agent", source: "entrypoint" };
  return undefined;
}

/**
 * @internal — named ONLY by `tests/support/process-kind.ts`, which is what
 * tests import. Do not import this anywhere else.
 *
 * 1F/N-4 asked for the reset to move to a test-only module, and this is as far
 * as plain ESM goes, stated plainly rather than dressed up: an export is
 * reachable by anything that can name the module, so "test-only" here is a rail
 * plus a name, not a structural impossibility. What the rail buys is real
 * though — this function un-declares an agent process, which means rule 40's
 * check in `createDb()` stops running, and it used to ship from production
 * source under a friendly name that read like ordinary housekeeping.
 *
 * `tests/support/process-kind.ts` is the only file permitted to name it, and
 * `tests/lint-rails.test.ts` scans the tree and fails if anything else does —
 * with the rail itself as the third and last name on that allowlist, because a
 * rail has to be able to write down what it bans.
 */
export function __resetDeclaredProcessKind(): void {
  declared = undefined;
  declaredBy = undefined;
}
