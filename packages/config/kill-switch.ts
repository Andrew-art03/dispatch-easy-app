/**
 * Kill switch for the app repo (CLAUDE.md rules 37, 40, 41, 47).
 *
 * SCOPE NOTE (1B): this is the *throwing* half of the kill switch only. The HQ
 * copy at `agents/kill-switch.ts` owns the persisted engaged/released state and
 * the incidents log. Persisting a trip from inside the app repo, and reaching a
 * human when one fires, are rule 36 / rule 48 work and land in 1C/1D — not here.
 * A trip must therefore never be swallowed: it throws, and the caller dies.
 */

/** Reasons a trip can fire. Mirrors the rule-47 auto-trigger list. */
export type KillSwitchReason =
  | "prod_target" // rule 40: a prod-classified target was reached for
  | "privilege" // a privileged client was built outside the allowlist
  | "secret_scope" // rule 41: a secret was read outside a skill's allowlist
  | "unknown_env"; // classification failed closed

export class KillSwitchTrip extends Error {
  readonly reason: KillSwitchReason;

  constructor(reason: KillSwitchReason, detail: string) {
    super(`KILL SWITCH [${reason}]: ${detail}`);
    this.name = "KillSwitchTrip";
    this.reason = reason;
  }
}

/**
 * Trip the kill switch. Never returns.
 *
 * The `never` return type is load-bearing: it makes TypeScript treat any code
 * after a call as unreachable, so a caller cannot accidentally continue past a
 * trip on a path the compiler checks.
 */
export function killSwitchTrip(reason: KillSwitchReason, detail: string): never {
  throw new KillSwitchTrip(reason, detail);
}
