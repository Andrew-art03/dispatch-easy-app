/**
 * THE Supabase client boundary — SPEC 1B v3.
 *
 * This is the only file in the repo permitted to import `@supabase/supabase-js`.
 * `bun run check:db-boundary` greps for violations and CI runs it.
 *
 * Why a factory and not a boot-time assert (CLAUDE.md rule 40): an assert at
 * startup can be skipped by any code path that builds its own client later. A
 * factory that is the only source of clients cannot be. Every client in the app
 * comes from here, and every one is checked at the moment it is built.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  SERVICE_KEY_NAMES,
  USER_KEY_NAMES,
  getEnv,
  readEnvSource,
  validateCredential,
} from "./env.ts";
import { killSwitchTrip } from "./kill-switch.ts";
// P-1C-2: the keys this factory hands out go onto the scrubber's PRIMARY rail
// (exact-value registry), not only the shape-pattern backstop. No cycle:
// agents/secrets.ts imports only ./kill-switch.ts, which imports nothing.
import { registerSecretValue } from "../../agents/secrets.ts";

/**
 * Modules allowed to build a privileged (service-role) client. Deliberately
 * empty in 1B: nothing legitimately needs service-role yet, so anything asking
 * for one right now is a bug or an attack. 1D adds the migration runner.
 */
const PRIVILEGED_CALLERS = new Set<string>([]);

export type ClientKind = "user" | "privileged";

export interface CreateDbOptions {
  /** The end user's JWT. Required for `user` clients so RLS sees a real subject (rule 4). */
  jwt?: string;
  /** Overrides the inferred caller module. Tests set this explicitly. */
  caller?: string;
}

/**
 * Best-effort caller identification from the stack. Used only to *deny* — a
 * caller that cannot be identified is refused rather than allowed, so a
 * spoofed or missing frame fails closed.
 */
function callerModule(explicit?: string): string {
  if (explicit) return explicit;
  const stack = new Error().stack;
  if (!stack) return "<unknown>";
  // [0] "Error", [1] callerModule, [2] createDb, [3] the actual caller
  const frame = stack.split("\n")[3];
  return frame?.trim() ?? "<unknown>";
}

/**
 * Both readers use `readEnvSource()` — the same merged `import.meta.env` +
 * `process.env` view the classifier resolves against (P-1B-2). Reading
 * `process.env` directly here would leave the browser bundle unable to find
 * its own URL and key even after `getEnv()` had classified it correctly.
 */
/**
 * First configured variable from `names`, returned WITH its name so the value
 * can be registered under it — a scrubbed log line reads `[redacted:NAME]`,
 * and "which key leaked" is the first thing an operator needs to know.
 */
function firstConfigured(
  source: Record<string, string | undefined>,
  names: readonly string[],
): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = source[name];
    if (value) return { name, value };
  }
  return undefined;
}

// 1F/H-4: the accepted names come from env.ts's one canonical table and are no
// longer restated here.
//
// This file used to keep its own `USER_KEY_NAMES`, which accepted the
// publishable names while env.ts's JWT-only `KEY_VARS` had never heard of them.
// A name the factory accepted and the classifier did not know about is, by
// construction, a name no agreement check ran on — so 1B's strongest check did
// not execute for the key format the front end actually ships. Two lists were
// the defect; one list, imported, is the fix. `USER_KEY_NAMES` and
// `SERVICE_KEY_NAMES` are now derived from each name's declared CAPABILITY,
// so the split cannot drift from what the values are allowed to do.

function readTarget(): { url: string; key: string } {
  const source = readEnvSource();
  const url = source["SUPABASE_URL"] ?? source["VITE_SUPABASE_URL"];
  if (!url) throw new Error("no Supabase URL configured");
  const found = firstConfigured(source, USER_KEY_NAMES);
  // Fail with our own message rather than letting supabase-js report a bare
  // "supabaseKey is required" from three frames down.
  if (!found) throw new Error("no Supabase anon/publishable key configured");
  // 1F/H-4: validate the VALUE against the NAME before handing it out. `getEnv()`
  // has normally already done this for the whole environment, but this reader is
  // reachable on its own and a check that only runs on the common path is not a
  // check. Refuses a JWT in a publishable-named variable (which is how the
  // agreement check used to be skipped) and a service-role JWT in an anon name
  // (which is how an RLS-bypassing key reaches a browser).
  validateCredential(found.name, found.value);
  // P-1C-2: on the primary rail from the moment it is handed out. A publishable
  // key is public by design, but in a log it still fingerprints WHICH project a
  // line came from — the same reason the shape pattern already redacts it.
  registerSecretValue(found.name, found.value);
  return { url, key: found.value };
}

/**
 * Exported for one reason: P-1C-2's regression test. `PRIVILEGED_CALLERS` is
 * empty in 1B, so `createDb("privileged")` trips the kill switch before it could
 * ever reach this function — the only way to prove the service key lands on the
 * scrubber's rail is to call the reader directly. It returns a string, never a
 * client; the factory guard is untouched.
 */
export function readServiceKey(): string {
  const found = firstConfigured(readEnvSource(), SERVICE_KEY_NAMES);
  if (!found) throw new Error("no service-role key configured");
  // 1F/H-4, the capability half, at the one place it matters most: a name is a
  // claim, a value is a fact. This function's whole purpose is establishing
  // privileged access, so it must never be satisfied by a credential that cannot
  // bypass RLS. An anon JWT sitting in SCRATCH_SERVICE_ROLE — or a publishable
  // key put there by someone tidying up an .env — is refused here rather than
  // handed out and discovered later as a permissions mystery.
  validateCredential(found.name, found.value);
  // P-1C-2: the highest-value secret in the system, registered by name before any
  // caller can log it. Previously it relied on the JWT shape pattern alone.
  registerSecretValue(found.name, found.value);
  return found.value;
}

/**
 * Build a Supabase client. Trips the kill switch rather than returning one when
 * the request violates rule 40 or the privileged-caller allowlist.
 */
export function createDb(kind: ClientKind, opts: CreateDbOptions = {}): SupabaseClient {
  const env = getEnv();

  // Rule 40. An agent process must never hold a client onto prod, full stop.
  if (env.isAgentProcess && env.envClass === "prod") {
    killSwitchTrip("prod_target", "agent process attempted to build a prod client");
  }

  if (kind === "privileged") {
    const caller = callerModule(opts.caller);
    if (!PRIVILEGED_CALLERS.has(caller)) {
      killSwitchTrip("privilege", `privileged client requested outside allowlist by ${caller}`);
    }
  }

  const { url, key } = readTarget();
  const apiKey = kind === "privileged" ? readServiceKey() : key;

  return createClient(url, apiKey, {
    ...(opts.jwt ? { global: { headers: { Authorization: `Bearer ${opts.jwt}` } } } : {}),
  });
}

/**
 * Defence in depth only. The real guarantee is that `createDb` refuses; this
 * gives a non-client operation (a migration, a script) somewhere to assert.
 */
export function assertNotProd(op: string): void {
  if (getEnv().envClass === "prod") {
    killSwitchTrip("prod_target", `${op} against prod`);
  }
}
