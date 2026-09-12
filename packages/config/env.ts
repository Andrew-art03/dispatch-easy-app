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
const CACHE_KEY_VARS = [...TARGET_VARS, ...KEY_VARS, "EZ_ENV_CLAIM", "EZ_PROCESS_KIND"] as const;

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
