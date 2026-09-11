/**
 * Environment classification — SPEC 1B v3 (signed Grok + ChatGPT).
 *
 * `scratch | staging | prod` is derived from what a connection actually points
 * at, never from a label anyone typed. Anything the parser cannot positively
 * identify throws `UnknownEnvironment`. Unknown is never "probably scratch".
 *
 * CLAUDE.md rule 40: agent worker credentials cannot reach anything classified
 * `prod` — structurally, not by convention. `db.ts` is where that is enforced;
 * this file only decides what a target *is*.
 *
 * Secrets discipline (rule 6): no function here ever puts a raw target string
 * into an error message. A `postgres://` URL carries its password inline, so an
 * error that echoed the input would leak it into logs and CI output. Errors
 * name the hostname and nothing else.
 */

export type EnvClass = "scratch" | "staging" | "prod";

/** Project refs are identifiers, not secrets — hard-coding them is correct. The keys are the secret (1C). */
const PROD_REFS = new Set<string>(["efeaylkqgqhobookcqby"]);
const STAGING_REFS = new Set<string>([]); // filled when staging exists
const SCRATCH_REFS = new Set<string>(["krwcnieffeasjczkwrlz"]); // ez-scratch, created 1D

/** Exact hostnames only. Any other raw IP or ref-less supabase host throws (Grok v2). */
const LOCAL_HOSTS = new Set<string>(["localhost", "127.0.0.1", "kong", "supabase_kong_ez"]);

const REF = /^[a-z0-9]{20}$/;

export class UnknownEnvironment extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownEnvironment";
  }
}

export type Target = { ref: string } | { local: true };

/**
 * Parse a target that may be a `postgres://` URL, an `https://` URL, or a bare
 * `host:port`. Never echoes the input — see the secrets note above.
 */
function safeUrl(target: string): URL {
  const trimmed = target.trim();
  if (trimmed === "") throw new UnknownEnvironment("empty target");
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  try {
    // Scheme-less input needs a placeholder, or `new URL("localhost:54321")`
    // parses "localhost:" as the protocol and loses the hostname entirely.
    return new URL(hasScheme ? trimmed : `ez-opaque://${trimmed}`);
  } catch {
    throw new UnknownEnvironment("target is not a parseable URL or host:port");
  }
}

/**
 * Extract a project ref from any Supabase-shaped target: api host, direct db
 * host, or pooler user. Throws on anything it cannot positively identify —
 * custom domains included.
 */
export function refOf(target: string): Target {
  const u = safeUrl(target);
  const hostname = u.hostname.toLowerCase();

  if (LOCAL_HOSTS.has(hostname)) return { local: true };

  const api = /^([a-z0-9]{20})\.supabase\.co$/.exec(hostname);
  if (api?.[1]) return { ref: api[1] };

  const directDb = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(hostname);
  if (directDb?.[1]) return { ref: directDb[1] };

  // Pooler hosts (aws-0-us-east-1.pooler.supabase.com) carry the ref in the
  // username as `postgres.<ref>`, not in the hostname.
  const pooler = /^postgres\.([a-z0-9]{20})$/.exec(u.username);
  if (pooler?.[1]) return { ref: pooler[1] };

  throw new UnknownEnvironment(`cannot identify project for ${hostname}`);
}

function decodeBase64Url(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return atob(withPadding);
}

/**
 * v3 (ChatGPT): a key's `ref` claim is trusted only if the JWT is structurally
 * valid — three base64url segments, parseable JSON payload, `iss` === "supabase",
 * `role` ∈ {anon, service_role}, `ref` matching /^[a-z0-9]{20}$/.
 *
 * A malformed key must never silently classify. This does NOT verify the
 * signature — it cannot, without the project's JWT secret. It establishes that
 * the ref claim is well-formed and self-consistent, and `classify()` then
 * requires it to agree with the URL-derived ref, so a forged key alone cannot
 * move the classification.
 */
export function refOfJwt(key: string): string {
  const parts = key.trim().split(".");
  if (parts.length !== 3) throw new UnknownEnvironment("key is not a three-segment JWT");

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(parts[1] ?? ""));
  } catch {
    throw new UnknownEnvironment("JWT payload is not decodable JSON");
  }
  if (typeof payload !== "object" || payload === null) {
    throw new UnknownEnvironment("JWT payload is not an object");
  }

  const claims = payload as Record<string, unknown>;
  if (claims["iss"] !== "supabase") throw new UnknownEnvironment("JWT iss is not supabase");

  const role = claims["role"];
  if (role !== "anon" && role !== "service_role") {
    throw new UnknownEnvironment("JWT role is not anon or service_role");
  }

  const ref = claims["ref"];
  if (typeof ref !== "string" || !REF.test(ref)) {
    throw new UnknownEnvironment("JWT ref claim is missing or malformed");
  }
  return ref;
}

/** Every target and key must agree on exactly one class. Unknown ref or mixed classes throw. */
export function classify(refs: Iterable<Target | string>): EnvClass {
  const classes = new Set<EnvClass>();
  let seen = false;

  for (const r of refs) {
    seen = true;
    if (typeof r === "object" && "local" in r) {
      classes.add("scratch");
      continue;
    }
    const ref = typeof r === "string" ? r : r.ref;
    if (PROD_REFS.has(ref)) classes.add("prod");
    else if (STAGING_REFS.has(ref)) classes.add("staging");
    else if (SCRATCH_REFS.has(ref)) classes.add("scratch");
    else throw new UnknownEnvironment(`ref ${ref} is not in any allowlist`);
  }

  if (!seen) throw new UnknownEnvironment("no targets to classify");
  if (classes.size !== 1) {
    throw new UnknownEnvironment(`mixed environments: ${[...classes].sort().join(", ")}`);
  }
  return [...classes][0] as EnvClass;
}

const TARGET_VARS = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_DB_URL",
  "DATABASE_URL",
  "SUPABASE_POOLER_URL",
] as const;

const KEY_VARS = [
  "SUPABASE_ANON_KEY",
  "VITE_SUPABASE_ANON_KEY",
  "SCRATCH_SERVICE_ROLE",
  "SUPABASE_SERVICE_ROLE",
] as const;

export type ProcessKind = "agent" | "app" | "edge";

export interface ResolvedEnv {
  readonly envClass: EnvClass;
  readonly isAgentProcess: boolean;
  readonly kind: ProcessKind;
}

export type EnvSource = Record<string, string | undefined>;

/**
 * Pure resolver — takes its source explicitly so tests never mutate the real
 * `process.env`, and so a caller can classify a candidate config without
 * adopting it.
 */
export function resolveEnv(source: EnvSource): ResolvedEnv {
  const targets = TARGET_VARS.map((k) => source[k])
    .filter((v): v is string => Boolean(v))
    .map(refOf);

  const jwtRefs = KEY_VARS.map((k) => source[k])
    .filter((v): v is string => Boolean(v))
    .map(refOfJwt);

  if (targets.length === 0) throw new UnknownEnvironment("no Supabase target configured");

  const envClass = classify([...targets, ...jwtRefs]);

  const claim = source["EZ_ENV_CLAIM"];
  if (claim && claim !== envClass) {
    throw new UnknownEnvironment(`EZ_ENV_CLAIM=${claim} but targets resolve to ${envClass}`);
  }

  // v3 (Grok): unset EZ_PROCESS_KIND defaults to 'agent'. The web app and Edge
  // Functions must OPT OUT explicitly. A forgotten variable fails safe.
  const kind = source["EZ_PROCESS_KIND"] ?? "agent";
  if (kind !== "agent" && kind !== "app" && kind !== "edge") {
    throw new UnknownEnvironment(`EZ_PROCESS_KIND=${kind}`);
  }

  return { envClass, isAgentProcess: kind === "agent", kind };
}

let cached: ResolvedEnv | undefined;

/**
 * Memoised resolution against the real environment.
 *
 * DEVIATION FROM SPEC, flagged for Cowork: the spec writes `env` as a
 * module-load IIFE. That makes merely *importing* db.ts throw, which breaks the
 * browser bundle (`process` is undefined there) and, more importantly,
 * contradicts the spec's own stated design — "the guarded connection factory,
 * not a boot-time assert, is the enforcement boundary". Resolution is therefore
 * lazy and memoised. The `env.envClass` / `env.isAgentProcess` read syntax is
 * unchanged, so no call site differs from the signed interface.
 */
export function getEnv(): ResolvedEnv {
  if (!cached) {
    const source = (globalThis as { process?: { env?: EnvSource } }).process?.env ?? {};
    cached = resolveEnv(source);
  }
  return cached;
}

/** Test-only: drop the memoised value so a new source can be resolved. */
export function resetEnvCache(): void {
  cached = undefined;
}

export const env = {
  get envClass(): EnvClass {
    return getEnv().envClass;
  },
  get isAgentProcess(): boolean {
    return getEnv().isAgentProcess;
  },
  get kind(): ProcessKind {
    return getEnv().kind;
  },
};
