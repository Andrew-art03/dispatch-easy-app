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

import { killSwitchTrip } from "./kill-switch.ts";
import {
  type KindSource,
  type ProcessKind,
  declaredProcessKindSource,
  provenProcessKind,
} from "./process-kind.ts";

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
export type JwtRole = "anon" | "service_role";

/**
 * The structural check, with the role claim kept rather than discarded.
 *
 * 1F/H-4 split this out of `refOfJwt` WITHOUT changing a single validation
 * step — the ticket said to keep the legacy JWT check exactly as-is and not
 * weaken it, and `refOfJwt` below is still the same function to every caller.
 * The only difference is that the role is now returned instead of being
 * validated and thrown away, because H-4's second half ("distinguish by
 * capability") needs to know whether a key can bypass RLS.
 */
function parseJwtClaims(key: string): { ref: string; role: JwtRole } {
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
  return { ref, role };
}

export function refOfJwt(key: string): string {
  return parseJwtClaims(key).ref;
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

// ---------------------------------------------------------------------------
// Accepted credential names — ONE canonical set (TICKET 1F item 3, finding H-4)
// ---------------------------------------------------------------------------
//
// THE DEFECT THIS FIXES. There used to be two lists. `KEY_VARS` here was
// JWT-only, so it was the set the URL-agreement check ran over. `db.ts` kept its
// own `USER_KEY_NAMES`, which additionally accepted
// `SUPABASE_PUBLISHABLE_KEY` / `VITE_SUPABASE_PUBLISHABLE_KEY` — the names the
// front end actually ships with. A name the factory accepted but the classifier
// had never heard of was, by construction, a name no agreement check ran on.
// 1B's strongest check simply did not execute for the key format we deploy.
//
// So: one list, here, and `db.ts` imports its names from it rather than keeping
// a second opinion. A name that is not on this list is not accepted anywhere.
//
// WHAT EACH NAME DECLARES:
//   formats     — which value shapes are legal under this name. A value of the
//                 wrong shape is a hard failure, not a coercion.
//   capability  — what the name is FOR. `privileged` means "may bypass RLS".
//                 A check whose purpose is establishing privileged access may
//                 only ever be satisfied by a `privileged` value, which is the
//                 second half of H-4 in one word.
//
// WHY `*_SERVICE_ROLE` IS JWT-ONLY. SPEC 1B v3.1 amendment 1: an `sb_*` value in
// a JWT-named variable stays a hard failure. When this repo adopts Supabase's
// `sb_secret_…` keys, that is a NEW NAME added to this table in the same diff
// that first reads it — never a quietly widened `formats` list on an existing
// name, because widening a format is invisible in a diff that reviews as config.
// TODO(1F/H-4): add the `sb_secret_*` name when a real secret key is issued.
export type KeyFormat = "jwt" | "sb_publishable" | "sb_secret";

/** `privileged` means the credential can bypass RLS. Nothing else does. */
export type Capability = "anon" | "privileged";

export interface CredentialSpec {
  readonly name: string;
  readonly formats: readonly KeyFormat[];
  readonly capability: Capability;
}

export const CREDENTIAL_NAMES: readonly CredentialSpec[] = [
  { name: "SUPABASE_ANON_KEY", formats: ["jwt"], capability: "anon" },
  { name: "VITE_SUPABASE_ANON_KEY", formats: ["jwt"], capability: "anon" },
  // Two formats, deliberately, and the asymmetry is the point. SPEC 1B v3.1
  // amendment 1 makes an `sb_*` value in a JWT-named variable a hard failure and
  // says nothing about the reverse, because the reverse is a real deployment: a
  // project issued before the new key format ships a legacy anon JWT, and it is
  // perfectly valid under the name the front end reads. Refusing it would break
  // a working config to buy nothing — whereas ACCEPTING it and then ref-checking
  // it is exactly what was missing. `capability: "anon"` still refuses a
  // service-role JWT here, which is the dangerous value under this name.
  { name: "SUPABASE_PUBLISHABLE_KEY", formats: ["sb_publishable", "jwt"], capability: "anon" },
  {
    name: "VITE_SUPABASE_PUBLISHABLE_KEY",
    formats: ["sb_publishable", "jwt"],
    capability: "anon",
  },
  { name: "SCRATCH_SERVICE_ROLE", formats: ["jwt"], capability: "privileged" },
  { name: "SUPABASE_SERVICE_ROLE", formats: ["jwt"], capability: "privileged" },
] as const;

const CREDENTIAL_BY_NAME = new Map(CREDENTIAL_NAMES.map((c) => [c.name, c]));

/** Every accepted credential name, in declaration order. */
export const CREDENTIAL_VAR_NAMES = CREDENTIAL_NAMES.map((c) => c.name);

/** Names a user (non-privileged) client may be built from. `db.ts` reads this. */
export const USER_KEY_NAMES = CREDENTIAL_NAMES.filter((c) => c.capability === "anon").map(
  (c) => c.name,
);

/** Names a privileged client may be built from. `db.ts` reads this. */
export const SERVICE_KEY_NAMES = CREDENTIAL_NAMES.filter(
  (c) => c.capability === "privileged",
).map((c) => c.name);

/**
 * Formats that carry NO verifiable project ref, so the URL is the sole authority
 * for them.
 *
 * THE HONEST LIMIT, stated here rather than discovered in review. H-4 as written
 * asked for "a per-format extractor plus one shared agreement assertion". There
 * is no extractor to write for these two: Supabase's `sb_publishable_…` and
 * `sb_secret_…` keys are opaque bearer tokens with no `ref` claim and no
 * project identifier of any kind — the SDK itself only ever tests their prefix.
 * SPEC 1B v3.1 amendment 1 says the same thing and is signed.
 *
 * Consequence, said plainly: the bad state H-4 named — URL pointing at scratch
 * while an opaque publishable key belongs to production — is NOT detectable in
 * code, by this or by anything else, and no amount of extractor writing changes
 * that. What IS now enforced, and was not before:
 *
 *   - a JWT under ANY accepted name is ref-checked against the URL, including
 *     the publishable-named variables, which is where the check used to be
 *     skipped entirely;
 *   - a value whose shape does not match its name is refused;
 *   - a non-privileged value can never satisfy a privileged name.
 *
 * The residual gap is an opaque key pointed at the wrong project. It is
 * mitigated operationally (one `.env` per environment) and structurally by rule
 * 40's agent deny, not by this function. Do not let a later reading of this file
 * conclude the agreement check covers every key we accept — it covers every key
 * that carries something to agree with.
 */
export const OPAQUE_KEY_FORMATS: readonly KeyFormat[] = ["sb_secret", "sb_publishable"];

const SB_PUBLISHABLE_PREFIX = "sb_publishable_";
const SB_SECRET_PREFIX = "sb_secret_";

/**
 * Identify a credential's format from its shape alone. Rule 6: the error names
 * the format problem, never the value — this runs on live keys.
 */
export function detectKeyFormat(value: string): KeyFormat {
  const v = value.trim();
  if (v.startsWith(SB_PUBLISHABLE_PREFIX)) return "sb_publishable";
  if (v.startsWith(SB_SECRET_PREFIX)) return "sb_secret";
  // Cheap structural test only. `parseJwtClaims` does the real validation and
  // throws with a specific reason; getting here on a three-part non-JWT is the
  // right outcome, because "looks like a JWT and is not one" must fail loudly
  // rather than fall through to "unrecognised".
  if (v.split(".").length === 3) return "jwt";
  throw new UnknownEnvironment("credential value is not a recognised key format");
}

/**
 * What a VALUE is actually capable of, derived from the value, never from the
 * variable it was found in. That direction is the whole point: the name is a
 * claim, the value is the fact.
 */
function capabilityOfValue(format: KeyFormat, value: string): Capability {
  if (format === "sb_publishable") return "anon";
  if (format === "sb_secret") return "privileged";
  return parseJwtClaims(value).role === "service_role" ? "privileged" : "anon";
}

/**
 * Validate one configured credential against the name it was found under, and
 * return the project ref it claims — `undefined` when its format carries none.
 *
 * Three ways this refuses, all of them states 1B accepted before 1F:
 *   1. an unknown variable name;
 *   2. a value whose shape is not legal under that name (an `sb_*` value in a
 *      JWT-named variable, a JWT in a publishable-named one);
 *   3. a capability mismatch — an anon JWT sitting in `*_SERVICE_ROLE`, so the
 *      privileged read is satisfied by something that cannot bypass RLS, or a
 *      service-role JWT sitting in an anon name, which is the version that
 *      ships an RLS-bypassing key to a browser.
 */
export function validateCredential(name: string, value: string): { ref?: string } {
  const spec = CREDENTIAL_BY_NAME.get(name);
  if (!spec) throw new UnknownEnvironment(`${name} is not an accepted credential name`);

  const format = detectKeyFormat(value);
  if (!spec.formats.includes(format)) {
    throw new UnknownEnvironment(
      `${name} holds a ${format} value; this name accepts ${spec.formats.join(" or ")} only`,
    );
  }

  const capability = capabilityOfValue(format, value);
  if (capability !== spec.capability) {
    throw new UnknownEnvironment(
      `${name} is a ${spec.capability} credential name but holds a value with ` +
        `${capability} capability`,
    );
  }

  if (OPAQUE_KEY_FORMATS.includes(format)) return {};
  return { ref: parseJwtClaims(value).ref };
}

/**
 * Every configured credential, validated, reduced to the refs that can be
 * cross-checked. This is the "one shared agreement assertion" half of H-4: the
 * refs it returns go into `classify()` alongside the URL-derived ones, so a key
 * that disagrees with its URL produces a mixed-environment throw — whatever
 * variable it was configured under.
 */
export function credentialRefs(source: Record<string, string | undefined>): string[] {
  const refs: string[] = [];
  for (const spec of CREDENTIAL_NAMES) {
    const value = source[spec.name];
    if (!value) continue;
    const { ref } = validateCredential(spec.name, value);
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

/**
 * `ProcessKind` moved to process-kind.ts at 1F, where the code-level
 * declaration lives. Re-exported so no existing import has to move.
 */
export type { KindSource, ProcessKind } from "./process-kind.ts";

export interface ResolvedEnv {
  readonly envClass: EnvClass;
  readonly isAgentProcess: boolean;
  readonly kind: ProcessKind;
  /** Which leg decided `kind`. `env`/`default` mean nothing in code claimed this process. */
  readonly kindSource: KindSource;
}

export type EnvSource = Record<string, string | undefined>;

/**
 * Pure resolver — takes its source explicitly so tests never mutate the real
 * `process.env`, and so a caller can classify a candidate config without
 * adopting it.
 */
export function resolveEnv(
  source: EnvSource,
  proven: { kind: ProcessKind; source: KindSource } | undefined = provenProcessKind(),
): ResolvedEnv {
  const targets = TARGET_VARS.map((k) => source[k])
    .filter((v): v is string => Boolean(v))
    .map(refOf);

  // 1F/H-4: every ACCEPTED credential name, not just the JWT-named four. Each
  // value is checked against the name it was found under — shape, then
  // capability — and contributes a ref where its format carries one. The
  // publishable names used to be accepted by the factory and unknown to this
  // function, which is precisely how 1B's agreement check came to be skipped for
  // the key format the app actually ships.
  const keyRefs = credentialRefs(source);

  if (targets.length === 0) throw new UnknownEnvironment("no Supabase target configured");

  const envClass = classify([...targets, ...keyRefs]);

  const claim = source["EZ_ENV_CLAIM"];
  if (claim && claim !== envClass) {
    throw new UnknownEnvironment(`EZ_ENV_CLAIM=${claim} but targets resolve to ${envClass}`);
  }

  // v3 (Grok): unset EZ_PROCESS_KIND defaults to 'agent'. The web app and Edge
  // Functions must OPT OUT explicitly. A forgotten variable fails safe.
  //
  // 1F/C-2: that default is only half of it. The variable is ordinary
  // environment input, so the opt-out it provides was available to the agent
  // process too — set it and rule 40's check in db.ts never runs. What a
  // process can be proven to be in code now OUTRANKS the variable, and the
  // variable is only consulted when there is no proof either way.
  const claimed = source["EZ_PROCESS_KIND"];
  if (claimed !== undefined && claimed !== "agent" && claimed !== "app" && claimed !== "edge") {
    // A typo is a typo, not a bypass attempt. Same error 1B always threw.
    throw new UnknownEnvironment(`EZ_PROCESS_KIND=${claimed}`);
  }

  if (proven !== undefined) {
    // The variable may agree, or be absent. It may not overrule.
    if (claimed !== undefined && claimed !== proven.kind) {
      const by = proven.source === "declared" ? declaredProcessKindSource() : "the entrypoint path";
      killSwitchTrip(
        "process_kind",
        `EZ_PROCESS_KIND=${claimed} contradicts ${proven.kind}, established by ${by}. ` +
          `Process identity is not settable by environment (1F/C-2).`,
      );
    }
    return {
      envClass,
      isAgentProcess: proven.kind === "agent",
      kind: proven.kind,
      kindSource: proven.source,
    };
  }

  const kind: ProcessKind = claimed ?? "agent";
  return {
    envClass,
    isAgentProcess: kind === "agent",
    kind,
    kindSource: claimed === undefined ? "default" : "env",
  };
}

/**
 * Every variable whose value can change a resolution. The memo is keyed on
 * these so that a changed environment invalidates it instead of being masked by
 * a verdict cached earlier.
 *
 * Rule 6: these values include keys. They are held only as references to the
 * same immutable strings `process.env` already holds — no copy is made, and the
 * key is only ever compared, never logged, serialised or put in an error.
 */
// 1F/H-4 widened this from the four JWT names to every accepted credential name.
// The publishable names were missing from the memo key, which was harmless only
// while they were also missing from the classification. They now change the
// verdict, so they have to invalidate it — the same cache-bypass shape Gemini
// found on the env vars, one name over.
const CACHE_KEY_VARS = [
  ...TARGET_VARS,
  ...CREDENTIAL_VAR_NAMES,
  "EZ_ENV_CLAIM",
  "EZ_PROCESS_KIND",
] as const;

let cached: ResolvedEnv | undefined;
let cachedKey: readonly (string | undefined)[] | undefined;

/**
 * 1F/C-2: the proven kind is part of the key too. It does not live in
 * `source`, so without this a resolution taken before `agents/agent-process.ts`
 * was imported would be served back afterwards — the same shape of cache bypass
 * Gemini found on the env vars, one field over.
 */
function cacheKeyOf(
  source: EnvSource,
  proven: { kind: ProcessKind; source: KindSource } | undefined,
): readonly (string | undefined)[] {
  return [...CACHE_KEY_VARS.map((name) => source[name]), proven?.kind, proven?.source];
}

function sameKey(
  a: readonly (string | undefined)[],
  b: readonly (string | undefined)[],
): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

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
 *
 * The memo is keyed, not unconditional. Caching the FIRST resolution forever was
 * a kill-switch bypass: anything that resolved during startup — a build-time
 * evaluation, a healthcheck route, a test bootstrap — before the real target
 * variables were populated would pin a benign verdict permanently, and every
 * later `createDb()` would read it and skip the rule-40 trip. Lazy resolution is
 * correct (a shell export or `.env.local` can supersede the intended value);
 * caching it forever was the defect. Found by Gemini under adversarial review;
 * regression test in tests/env-cache-bypass.test.ts.
 *
 * A failed resolution is deliberately not cached, so a broken environment throws
 * on every call rather than once.
 */
/**
 * The environment as this process can actually see it (P-1B-2, panel pass).
 *
 * Vite exposes `VITE_*` to the browser bundle ONLY through `import.meta.env`,
 * and `process` is undefined there — so a resolver that read `process.env`
 * alone could never classify inside the app, which is the one place rule 40's
 * `kind === "app"` opt-out is meant to run. Under Node/Bun/vitest both objects
 * usually exist. Merged, with `process.env` winning: a shell export at runtime
 * supersedes a value inlined at build time, never the other way round.
 *
 * Both reads are guarded. `import.meta.env` is a Vite-ism: outside Vite it is
 * `undefined` and must not throw, and `import.meta` itself is only legal in an
 * ES module — this file is one. Typed as `EnvSource` (string | undefined
 * values) rather than Vite's `ImportMetaEnv`, because `packages/config` must
 * not depend on Vite's ambient types to compile.
 *
 * Shared with db.ts so the factory and the classifier can never disagree about
 * what the environment contains.
 */
export function readEnvSource(): EnvSource {
  return mergeEnvSources(
    (import.meta as ImportMeta & { env?: unknown }).env,
    (globalThis as { process?: { env?: unknown } }).process?.env,
  );
}

/**
 * The pure merge behind `readEnvSource()`, exported so the browser case can be
 * tested honestly: under vitest `import.meta.env` is a proxy over `process.env`,
 * so "delete `process` and read `import.meta.env`" cannot be simulated in the
 * test runner — the two are the same object there. Feeding this function a meta
 * object and `undefined` for process IS the browser, with nothing faked.
 *
 * Either input may be anything (undefined, null, a Vite env object, a Proxy);
 * only plain-object inputs contribute. `proc` wins on collisions.
 */
export function mergeEnvSources(meta: unknown, proc: unknown): EnvSource {
  const fromMeta = typeof meta === "object" && meta !== null ? (meta as EnvSource) : {};
  const fromProcess = typeof proc === "object" && proc !== null ? (proc as EnvSource) : {};
  return { ...fromMeta, ...fromProcess };
}

export function getEnv(): ResolvedEnv {
  const source = readEnvSource();
  const proven = provenProcessKind();
  const key = cacheKeyOf(source, proven);
  if (cached !== undefined && cachedKey !== undefined && sameKey(key, cachedKey)) {
    return cached;
  }
  cached = resolveEnv(source, proven);
  cachedKey = key;
  return cached;
}

/** Test-only: drop the memoised value so a new source can be resolved. */
export function resetEnvCache(): void {
  cached = undefined;
  cachedKey = undefined;
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
