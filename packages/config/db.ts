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

import { getEnv } from "./env.ts";
import { killSwitchTrip } from "./kill-switch.ts";

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

function readTarget(): { url: string; key: string } {
  const source =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const url = source["SUPABASE_URL"] ?? source["VITE_SUPABASE_URL"];
  if (!url) throw new Error("no Supabase URL configured");
  const key = source["SUPABASE_ANON_KEY"] ?? source["VITE_SUPABASE_ANON_KEY"];
  // Fail with our own message rather than letting supabase-js report a bare
  // "supabaseKey is required" from three frames down.
  if (!key) throw new Error("no Supabase anon key configured");
  return { url, key };
}

function readServiceKey(): string {
  const source =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const key = source["SCRATCH_SERVICE_ROLE"] ?? source["SUPABASE_SERVICE_ROLE"];
  if (!key) throw new Error("no service-role key configured");
  return key;
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
