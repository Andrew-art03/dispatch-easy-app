/**
 * SPEC 4A — R1: "Nothing is ever dropped."
 *
 * Two separate obligations, and v1 of the spec collapsed them, which is what
 * made the accounting test unexecutable:
 *
 *   raw_payload  a structural clone of EVERYTHING that arrived, verbatim, always
 *   unmapped[]   every span 4A did not map to a field, listed separately
 *
 * The second exists because the first is not a signal. Nothing downstream can be
 * expected to diff a blob, so a detention clause we could not parse would sit in
 * `raw_payload` being technically preserved and practically invisible.
 *
 * The reason both exist is money: a dropped line is a silently lost fact about
 * someone's load, and the driver cannot know it went missing.
 */

import { sha256 } from "./sha256.ts";

export type CanonicalFailure = { ok: false; reason: "unparseable"; detail: string };
export type CanonicalOk = { ok: true; canonical: string; clone: unknown };

/** Values JSON cannot round-trip. Any of them means we cannot honour R1's accounting. */
function isNonJsonPrimitive(value: unknown): boolean {
  const t = typeof value;
  return t === "function" || t === "symbol" || t === "bigint" || t === "undefined";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Deep clone with a stated key order (insertion order, preserved) and no shared
 * references with the input. `raw_payload` must not change when the caller later
 * mutates the object it handed us, and must not be a route for mutating it back.
 */
function clone(value: unknown, seen: Set<object>): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new RangeError("cyclic value");
    seen.add(value);
    const out = value.map((entry) => clone(entry, seen));
    seen.delete(value);
    return out;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) throw new RangeError("cyclic value");
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key], seen);
    seen.delete(value);
    return out;
  }
  throw new TypeError("non-JSON value");
}

/** Lexicographic key sort, stated in code (R1) so the hash is not implementation-defined. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/** Uint8Array rendered as its bytes, stably — "the bytes themselves". */
function bytesToLatin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/**
 * `canonical(x)`, exactly as R1 states it:
 *   - a `string` or `Uint8Array` -> the bytes themselves
 *   - a plain object            -> `sha256(JSON.stringify(sortKeys(x)))`
 *
 * Note the nesting that follows from the spec's own wording: `contentHash` is
 * `sha256(canonical(raw))`, so for an object payload the content hash is a hash
 * of a hash. That is deliberate and it is left as written — both R1 assertions
 * (`canonical(raw_payload) === canonical(raw)` and the contentHash identity) hold
 * either way, and a reviewer checking this file against the spec should find the
 * spec's formula and not a tidier one.
 */
export function canonical(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return bytesToLatin1(value);
  return sha256(JSON.stringify(sortKeys(value)) ?? "undefined");
}

/**
 * Clone `raw` and compute its canonical form, or report that it cannot be done.
 * "A cyclic or non-JSON value returns NEEDS_INPUT on path `raw`."
 */
export function canonicalize(raw: unknown): CanonicalOk | CanonicalFailure {
  if (isNonJsonPrimitive(raw)) {
    return {
      ok: false,
      reason: "unparseable",
      detail: `raw is a ${typeof raw}, which JSON cannot carry`,
    };
  }
  let cloned: unknown;
  try {
    cloned = clone(raw, new Set<object>());
  } catch (error) {
    const detail =
      error instanceof RangeError ? "raw contains a cycle" : "raw contains a non-JSON value";
    return { ok: false, reason: "unparseable", detail };
  }
  return { ok: true, canonical: canonical(cloned), clone: cloned };
}

export type Leaf = { path: string; value: unknown };

/**
 * Every leaf in the payload, with a dotted path. This is the ledger R1's
 * `unmapped` is computed against: a leaf whose path was never consumed by a
 * mapping rule is, by definition, a span 4A did not map.
 */
export function collectLeaves(value: unknown, prefix = ""): Leaf[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectLeaves(entry, `${prefix}[${index}]`));
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return [{ path: prefix === "" ? "$" : prefix, value: {} }];
    return keys.flatMap((key) =>
      collectLeaves(value[key], prefix === "" ? key : `${prefix}.${key}`),
    );
  }
  return [{ path: prefix === "" ? "$" : prefix, value }];
}

/** How a leaf is shown inside an `unmapped` entry. Data, never re-parsed. */
export function renderLeaf(leaf: Leaf): string {
  const shown =
    typeof leaf.value === "string"
      ? leaf.value
      : (JSON.stringify(leaf.value) ?? String(leaf.value));
  return `${leaf.path} = ${shown}`;
}

export { isPlainObject };
