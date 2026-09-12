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
// The scrubber
// ---------------------------------------------------------------------------

/**
 * Values registered by `readSecret` and the config loader, keyed value -> name.
 */
const registered = new Map<string, string>();

/**
 * Minimum length for a registered value.
 *
 * A short value would match constantly — a two-character secret would redact
 * every occurrence of those two characters in every log line, which destroys the
 * logs and, worse, teaches people that redaction output is noise.
 *
 * That leaves a gap this threshold must not paper over: a value under the
 * threshold is NOT covered by the pattern rules unless it happens to have a known
 * shape, and most do not. So `readSecret` refuses to hand one out at all (1C-1)
 * and `registerSecretValue` refuses to accept one at all (1F/H-5).
 *
 * The wording here used to be "the registry skipping it here is only safe
 * because the read path fails first". That stated a guarantee which held on
 * exactly one of the two doors into this registry. Nothing is skipped now, so
 * the guarantee no longer depends on which door a value came through.
 */
const MIN_REGISTERED_LENGTH = 8;

/**
 * Put a value on the scrubber's primary rail. Refuses anything too short to
 * register rather than skipping it.
 *
 * 1F/H-5 RESIDUAL — the hole this closes. This function used to skip a
 * sub-threshold value silently, justified by `readSecret` throwing on one
 * first (1C-1). True of `readSecret`. False of `packages/config/db.ts`, which
 * calls this DIRECTLY from `readTarget()` and `readServiceKey()` (P-1C-2) and
 * never passes through that throw. Two fixes in two tickets, one hole between
 * them: on the db.ts path a short key was handed to its caller and quietly left
 * unregistered, so the scrubber could not redact it and nobody was told.
 *
 * Refusing, rather than registering regardless — the ticket offered both. A
 * two-character value on the rail would redact those two characters out of
 * every log line in the process, which destroys the logs and teaches people
 * that redaction output is noise. A credential that short is not a real
 * credential in any format this repo accepts, so failing closed costs nothing
 * real and the alternative costs the logs.
 *
 * Rule 6: the error names the variable and the length, never the value.
 */
export function registerSecretValue(name: string, value: string): void {
  if (value.length < MIN_REGISTERED_LENGTH) {
    throw new Error(
      `secret ${name} is ${value.length} characters; the scrubber cannot register values ` +
        `shorter than ${MIN_REGISTERED_LENGTH}, so it is refused rather than handed out unredactable`,
    );
  }
  registered.set(value, name);
  // 1F/H-6: a sink sees a secret in whatever form the code put it there in, not
  // in the form it was read in. A connection string inside a URL query, or any
  // value that has been through JSON.stringify, is the same secret with
  // different bytes — and exact-substring matching, which is what makes the
  // primary rail trustworthy, will not find it. So the encodings we can
  // enumerate are registered as aliases of the same NAME, and a leak in any of
  // them still redacts as `[redacted:<NAME>]`.
  //
  // Only lossless, mechanical encodings belong here. This is not an attempt to
  // guess every transformation a value could undergo — base64, gzip, a hash and
  // a split-and-rejoined string are all out of reach, by construction. The
  // pattern rail and, for streams, the sink's line buffering are what cover the
  // rest.
  for (const variant of encodedVariants(value)) {
    if (variant !== value && variant.length >= MIN_REGISTERED_LENGTH) {
      registered.set(variant, name);
    }
  }
}

/**
 * The mechanical re-encodings of a secret that a log line can plausibly contain.
 *
 * `encodeURIComponent` matters most for connection strings — `postgres://`,
 * `:`, `@` and a password's punctuation all change — which is exactly the class
 * of value whose leak is worst. The JSON form matters whenever a value has been
 * through `JSON.stringify` on its way to a log, which for structured logging is
 * most of the time.
 */
function encodedVariants(value: string): string[] {
  const out: string[] = [];
  try {
    out.push(encodeURIComponent(value));
  } catch {
    // Lone surrogates throw URIError. A value we cannot encode simply has no
    // URL-encoded form to register; the raw value is still on the rail.
  }
  // Strip the quotes JSON.stringify adds, so this matches the value as it
  // appears INSIDE a serialised object rather than only as a whole token.
  out.push(JSON.stringify(value).slice(1, -1));
  return out;
}

/**
 * The largest index at or before `cut` where `text` can be split without
 * orphaning the beginning of a registered secret in the part being cut away.
 *
 * 1F/H-7 needs this, and the reason is worth stating because the obvious
 * alternative is wrong. A stream sink that emits everything except the last N
 * characters does NOT prevent a split secret from leaking: a secret straddling
 * the cut has its FIRST characters in the emitted part, so the fragment goes out
 * unredacted, and no choice of N changes that — the leak is the prefix, not the
 * remainder. The sink's first draft did exactly this and its own test caught it.
 *
 * What is actually computable is this: pull the cut back to before any proper
 * prefix of a registered value that sits at the end of the emitted region. Then
 * the emitted text provably contains no partial registered secret, and any
 * COMPLETE occurrence inside it is redacted by `scrub` as usual. The retained
 * remainder stays in the buffer until the rest of the value arrives.
 *
 * Exact for the registry rail only. A pattern-matched credential — one that was
 * never registered, so nothing here knows its length — can still be split across
 * a forced emission. That residual is why `readSecret` / `registerSecretValue`
 * being the normal path matters, and it is stated at the sink too.
 */
export function safeSplitIndex(text: string, cut: number): number {
  let safe = Math.min(cut, text.length);
  for (const value of registered.keys()) {
    const longestProperPrefix = Math.min(value.length - 1, safe);
    for (let k = longestProperPrefix; k > 0; k -= 1) {
      if (text.startsWith(value.slice(0, k), safe - k)) {
        safe -= k;
        break;
      }
    }
  }
  return safe;
}

/** Test seam. Nothing under agents/skills may call it; the lint rule does not
 * cover this, so it is stated here and asserted in the manifest test. */
export function resetSecretRegistry(): void {
  registered.clear();
}

/**
 * Pattern rules, for credential shapes that were never read through
 * `readSecret` — a value pasted into a prompt, returned by a vendor, or read by
 * third-party code. Patterns are the backstop; the registry is the primary rail.
 *
 * sb_publishable_ is redacted even though it is not secret: 9A wants this same
 * scrubber for PII, and a publishable key in a log is still a fingerprint of
 * which project the line came from.
 */
const PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: "PRIVATE_KEY",
  },
  { re: /\bsb_secret_[A-Za-z0-9_-]{8,}/g, label: "SB_SECRET" },
  { re: /\bsb_publishable_[A-Za-z0-9_-]{8,}/g, label: "SB_PUBLISHABLE" },
  { re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, label: "JWT" },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, label: "API_KEY" },
  // Connection strings: redact the password, keep the scheme and host — an
  // operator needs to know WHICH database a line is about, and that is not the
  // secret. Same reasoning as 1B's error messages.
  { re: /\b([a-z+]+:\/\/[^:/\s]+):[^@\s]+@/g, label: "URL_PASSWORD" },
  // PII (rule 22; 9A depends on this)
  //
  // EMAIL keeps the domain (1C-3), for the same reason URL_PASSWORD keeps the
  // host: when 4C's forwarded-broker-email intake fails, an operator needs to
  // know WHICH broker's mail it was, and the domain is not the private part.
  // The local part is what identifies a person; that is what gets redacted.
  { re: /\b[A-Za-z0-9._%+-]+(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, label: "EMAIL" },
  //
  // PHONE (1C-2): bare 10/11-digit numbers must redact — a keypad produces no
  // separators, so `5551234567` is the common case, not the edge case. Every
  // separator is optional. What keeps this from eating epoch timestamps is not
  // a separator requirement but one NANP rule: an area code cannot begin with
  // 0 or 1. A 10-digit Unix epoch (`17…` for the next two centuries) fails at
  // its first digit, and the optional leading `1` cannot rescue it — that leaves
  // nine digits where ten are needed. The lookaround guards still stop a match
  // inside any longer digit run (load numbers, 13-digit IDs).
  //
  // The exchange is deliberately NOT constrained to [2-9]: the canonical test
  // number 555-123-4567 has a "1" exchange, and real logs are not NANP-clean.
  // Cost accepted: a 10-digit order ID starting 2–9 will redact as a phone.
  {
    re: /(?<!\d)(?:\+?1[-. ]?)?\(?[2-9]\d{2}\)?[-. ]?\d{3}[-. ]?\d{4}(?!\d)/g,
    label: "PHONE",
  },
  // MC_NUMBER was here until P-1C-3 (panel pass, 2026-09-11) and is gone on
  // purpose: an MC number is a PUBLIC FMCSA carrier/broker identifier, printed on
  // every rate con, and it is exactly what a dispatcher needs in an audit line to
  // know which carrier a load belongs to. Redacting it globally destroyed
  // observability on the core workflow while protecting nothing. EMAIL and PHONE
  // stay: those identify a person, an MC identifies a company.
];

/**
 * Redact secrets from a string.
 *
 * Registered values are replaced by exact substring match — split/join, not a
 * regex — so a value containing regex metacharacters cannot silently fail to
 * match. Longest first: if both a connection string and the password inside it
 * are registered, replacing the short one first leaves a mangled fragment of the
 * long one behind, which still discloses its shape and usually its host.
 */
export function scrub(text: string): string {
  let out = text;

  const byLength = [...registered.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [value, name] of byLength) {
    out = out.split(value).join(`[redacted:${name}]`);
  }

  for (const { re, label } of PATTERNS) {
    out = out.replace(re, (_match, ...groups) => {
      // Two rules keep a non-secret part so a log line stays attributable:
      // the host of a connection string, the domain of an email (1C-3).
      if (label === "URL_PASSWORD") return `${groups[0]}:[redacted:${label}]@`;
      if (label === "EMAIL") return `[redacted:${label}]${groups[0]}`;
      return `[redacted:${label}]`;
    });
  }

  return out;
}

/**
 * Redact recursively — for Sentry beforeSend, the audit writer and the
 * structured logger, which all hand over objects rather than strings.
 *
 * Object KEYS are scrubbed too. A log entry keyed by a customer email address
 * leaks exactly as much as one with the address in its value.
 */
export function scrubDeep<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === "string") return scrub(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;

  // Cycles are ordinary in Sentry event payloads; without this the scrubber
  // becomes the crash it was added to prevent.
  if (seen.has(value)) return "[circular]" as unknown as T;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => scrubDeep(v, seen)) as unknown as T;
  }

  if (value instanceof Error) {
    const e = new Error(scrub(value.message));
    e.name = value.name;
    if (value.stack) e.stack = scrub(value.stack);
    return e as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[scrub(k)] = scrubDeep(v, seen);
  }
  return out as unknown as T;
}
