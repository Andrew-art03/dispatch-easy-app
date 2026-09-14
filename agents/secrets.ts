/**
 * Secrets discipline — SPEC 1C. CLAUDE.md rules 6, 41, 47.
 *
 * Two mechanisms live here because they are two halves of one guarantee:
 *
 *   1. `readSecret()` is the ONLY sanctioned way a skill reads a secret. A skill
 *      may read exactly the names its manifest declares; anything else trips the
 *      kill switch (rule 41 — reading a secret outside the allowlist is a trip,
 *      not a workaround). This is the sibling-token leak class from doc 24.
 *
 *   2. The scrubber removes secret values from anything on its way to a human or
 *      a vendor — the structured logger, the audit writer, Sentry beforeSend. It
 *      works on the ACTUAL LOADED VALUES registered by `readSecret`, not only on
 *      patterns, because the pattern list can never be complete.
 *
 * Neither half is sufficient alone. (1) stops a skill reading the wrong key;
 * (2) stops the right key ending up in a log line, a stack trace or a Sentry
 * event. A secret read correctly and then printed is still a leaked secret.
 */

import "./agent-process.ts"; // 1F/C-2: declares this process an agent before anything can reach a DB
import { KillSwitchTrip } from "../packages/config/kill-switch.ts";
import { MIN_REGISTERED_LENGTH, registerSecretValue } from "../packages/config/scrubber.ts";

// ---------------------------------------------------------------------------
// The secret name registry
// ---------------------------------------------------------------------------

/**
 * Every env name in this repo whose VALUE is secret. A manifest may only name
 * something on this list; an unknown name is a hard failure at startup (SPEC 1C)
 * rather than a silent grant, so a typo cannot quietly widen an allowlist.
 *
 * Deliberately only names that exist in this repo today. Adding a provider means
 * adding its name here in the same diff that adds its first `readSecret` call —
 * which is the point: the grant is visible in review.
 *
 * NOT on this list, on purpose: SUPABASE_URL, VITE_SUPABASE_URL,
 * VITE_SUPABASE_PUBLISHABLE_KEY, project refs. Those are published to every
 * browser that loads the app; tenant isolation rests on RLS, not on hiding them.
 * Treating a public value as secret trains people to ignore the rail.
 */
export const SECRET_NAMES = [
  // Model providers
  "ANTHROPIC_API_KEY",
  // Supabase keys that bypass RLS
  "SUPABASE_SERVICE_ROLE",
  "SCRATCH_SERVICE_ROLE",
  // Supabase keys that do not bypass RLS but are still bearer credentials
  "SUPABASE_ANON_KEY",
  "VITE_SUPABASE_ANON_KEY",
  // Connection strings — these carry the database password inline
  "SUPABASE_DB_URL",
  "DATABASE_URL",
  "SUPABASE_POOLER_URL",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

const SECRET_NAME_SET: ReadonlySet<string> = new Set(SECRET_NAMES);

export function isSecretName(name: string): name is SecretName {
  return SECRET_NAME_SET.has(name);
}

// ---------------------------------------------------------------------------
// Skill manifests
// ---------------------------------------------------------------------------

export interface SkillManifest {
  readonly name: string;
  readonly secrets: readonly SecretName[];
  readonly maxDepth: 1;
}

/**
 * Build a frozen, validated manifest. Call it at module scope so a bad manifest
 * fails at import time, not on the first call in production.
 *
 * `maxDepth` is fixed at 1 by the type. SPEC 1C: depth is enforced by the skill
 * runner, not by what a skill declares about itself — a skill cannot grant
 * itself recursion by editing its own manifest.
 */
export function defineManifest(spec: { name: string; secrets: readonly string[] }): SkillManifest {
  if (!spec.name.trim()) throw new Error("skill manifest: name is required");

  for (const s of spec.secrets) {
    if (!isSecretName(s)) {
      throw new Error(
        `skill manifest ${spec.name}: unknown secret name ${s} — ` +
          `add it to SECRET_NAMES in agents/secrets.ts in the same change that first reads it`,
      );
    }
  }

  const seen = new Set(spec.secrets);
  if (seen.size !== spec.secrets.length) {
    throw new Error(`skill manifest ${spec.name}: duplicate secret names`);
  }

  return Object.freeze({
    name: spec.name,
    secrets: Object.freeze([...spec.secrets]) as readonly SecretName[],
    maxDepth: 1 as const,
  });
}

// ---------------------------------------------------------------------------
// The only sanctioned secret read
// ---------------------------------------------------------------------------

/**
 * Read one secret on behalf of one skill.
 *
 * Reading a name the manifest does not declare is a kill-switch trip, not a
 * plain Error: rule 41 classes it with the rule-47 auto-triggers, because a
 * skill reaching for a credential it was not granted is the signature of the
 * incident this rail exists to prevent — not an ordinary misconfiguration.
 *
 * A missing value is an ordinary Error. Nothing was reached for that was not
 * granted; the deployment is simply incomplete.
 */
export function readSecret(m: SkillManifest, name: string): string {
  if (!m.secrets.includes(name as SecretName)) {
    throw new KillSwitchTrip("secret_scope", `skill ${m.name} read ${name}`);
  }

  const v = readEnv(name);
  if (!v) throw new Error(`missing secret ${name}`);

  // 1C-1: a value too short to register would be handed to the skill and then be
  // invisible to the scrubber for the rest of the process. Fail closed. The error
  // names the variable and its length, never the value.
  if (v.length < MIN_REGISTERED_LENGTH) {
    throw new Error(
      `secret ${name} is ${v.length} characters; the scrubber cannot register values ` +
        `shorter than ${MIN_REGISTERED_LENGTH}, so it is not handed to skill ${m.name}`,
    );
  }

  // Registered on the way out, so anything that later logs this value is
  // scrubbed even if the leak happens somewhere that never heard of this module.
  registerSecretValue(name, v);
  return v;
}

/** Node and Deno both, since Edge Functions run on Deno (02-ARCHITECTURE). */
function readEnv(name: string): string | undefined {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    Deno?: { env?: { get(k: string): string | undefined } };
  };
  return g.process?.env?.[name] ?? g.Deno?.env?.get(name);
}

// ---------------------------------------------------------------------------
// The scrubber — moved to packages/config/scrubber.ts at 1F/N-1
// ---------------------------------------------------------------------------

/**
 * The scrubber is still half of 1C's guarantee and still belongs beside
 * `readSecret` in everything but file location, so it is re-exported here and
 * every existing import keeps working unchanged.
 *
 * It had to MOVE because of where the other door into the registry is.
 * `packages/config/db.ts` registers the keys it hands out (P-1C-2), so db.ts
 * imported this module — and this module declares the process an agent on line
 * 21. The one sanctioned client factory therefore turned every app process,
 * Edge Function and script that used it into an agent. That is 1F/N-1, and the
 * fix is that the registry no longer lives behind the declaration.
 *
 * The registry is a single process-wide Map in exactly one module. Re-exporting
 * does not copy it: a value registered through `readSecret` here and a value
 * registered through `createDb()` there land on the same rail, which is the
 * property the whole design rests on.
 */
export type { MultilineRegion } from "../packages/config/scrubber.ts";
export {
  MIN_REGISTERED_LENGTH,
  closingMarkerFor,
  firstMultilineRegion,
  registerSecretValue,
  resetSecretRegistry,
  safeSplitIndex,
  scrub,
  scrubDeep,
} from "../packages/config/scrubber.ts";
