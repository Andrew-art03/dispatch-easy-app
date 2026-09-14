/**
 * EZ-BUILD-01 Slice 5 (ticket 2E) — a retry is not a second load.
 *
 * SPEC 2E's stated failure mode, in its own words: "Double 'Take it' while the truck's on the
 * shoulder with one bar." Prevented server-side, not by disabling a button — a button that is
 * disabled on a phone that just lost signal is a button that was never disabled.
 *
 * THE PRIMARY KEY IS THE CONTRACT. `(org_id, operation, key)` is the uniqueness, and the
 * database enforces it. Nothing here checks first and inserts second: that pattern has a window
 * between the two statements exactly wide enough for the second tap to fit through. The claim
 * is an INSERT, and losing the race is how a caller discovers it lost.
 *
 * WHAT GOES INTO THE HASH, AND WHY IT IS ONLY THE BODY.
 * SPEC 2E writes `request_hash = sha256(canonical JSON: sorted keys, body minus
 * Idempotency-Key / timestamps / trace headers)`. Two readings:
 *
 *   (a) hash the body, and first strip fields NAMED like metadata — `timestamp`, `trace_id`;
 *   (b) hash the body, and never mix a header into it at all.
 *
 * This implements (b). Reading (a) is the dangerous one and it is worth saying why: a payload
 * with a legitimate business field named `timestamp` would have that field stripped, so two
 * genuinely DIFFERENT requests would hash identically — and the second would be handed the
 * first one's stored response as a success. A silent wrong answer is worse than a 409, and a
 * rate confirmation that comes back with somebody else's numbers is the worst version of it.
 * Under (b) the clause is satisfied because no header was ever a candidate: the
 * `Idempotency-Key` header, timestamps and trace headers are not in the hash because nothing
 * from the headers is.
 *
 * WHAT THIS FILE DOES NOT DO. It does not open a transaction — it cannot, because it holds no
 * database client (rule 40; the same reason context.ts takes its dependencies injected). The
 * `IdempotencyStore` it is handed is where SPEC 2E's "ONE transaction" lives, and the
 * interface is shaped so that a correct implementation is the obvious one: `claim` is a single
 * INSERT ... ON CONFLICT that returns what it found.
 */
import { HttpError, hasInvisible, type RequestContext } from "./context.ts";

/** What a claim on `(org_id, operation, key)` found. */
export type ClaimResult =
  /** The row is ours. Run the handler. */
  | { readonly status: "claimed" }
  /** Same key, same body, and a stored response. Replay it; do NOT run the handler. */
  | { readonly status: "replay"; readonly response: StoredResponse }
  /** Same key, same body, no response yet — another request is mid-flight with this key. */
  | { readonly status: "in_flight" }
  /** Same key, DIFFERENT body. The caller reused a key for a new action. */
  | { readonly status: "mismatch" };

export interface StoredResponse {
  readonly status: number;
  /** The response body as text. Capped at 64 KB by the database (0003). */
  readonly body: string;
  readonly contentType: string;
}

export interface IdempotencyStore {
  /**
   * ONE statement: insert `(orgId, operation, key, requestHash)` and, on conflict, report what
   * is already there. Never a SELECT followed by an INSERT — the gap between those two is
   * exactly the width of the second tap.
   */
  readonly claim: (row: {
    readonly orgId: string;
    readonly operation: string;
    readonly key: string;
    readonly requestHash: string;
  }) => Promise<ClaimResult>;
  /** Attach the response to the row claimed above, so a later retry can replay it. */
  readonly complete: (
    row: { readonly orgId: string; readonly operation: string; readonly key: string },
    response: StoredResponse,
  ) => Promise<void>;
  /** Release a claim whose handler failed, so the caller may legitimately try again. */
  readonly release: (row: {
    readonly orgId: string;
    readonly operation: string;
    readonly key: string;
  }) => Promise<void>;
}

/** SPEC 2E says ULID. A UUID is accepted too; anything else is not a key, it is a guess. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidIdempotencyKey(key: string): boolean {
  if (hasInvisible(key)) return false;
  return ULID.test(key) || UUID.test(key);
}

/**
 * Deterministic JSON: object keys sorted at every depth, arrays left in order, no whitespace.
 *
 * Non-finite numbers are REFUSED rather than serialised. `JSON.stringify` turns NaN and
 * Infinity into `null`, so `{rate: NaN}` and `{rate: null}` would hash the same — and on the
 * money path that is two different requests sharing one idempotency row.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new HttpError(400, `non-finite number in body`, "Malformed request body.");
    }
    // -0 and 0 are the same value to anyone reading a rate, and must hash the same.
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      // `undefined` is not JSON and cannot survive a round trip; dropping it here keeps a
      // parsed body and a constructed body hashing alike.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new HttpError(400, `unserialisable value in body`, "Malformed request body.");
}

/** sha256 of the canonical body, lower-case hex. Web Crypto — the same call in Deno and Node. */
export async function requestHash(body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(body));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutating(method: string): boolean {
  return MUTATING.has(method.toUpperCase());
}

/** The stored-response cap from migration 0003, checked before the row is written. */
export const MAX_STORED_RESPONSE_BYTES = 65536;

/**
 * Wrap one mutating handler.
 *
 * `run` is called AT MOST ONCE per `(org, operation, key)`. That is the whole promise, and the
 * side-effect counter in tests/idempotency.test.ts is what proves it rather than asserting it.
 */
export async function idempotent(
  ctx: RequestContext,
  req: Request,
  operation: string,
  store: IdempotencyStore,
  run: (body: unknown) => Promise<Response>,
): Promise<Response> {
  if (!isMutating(req.method)) {
    // A GET has nothing to replay and no row to write. Wrapping one would put a row in the
    // table for every page view.
    throw new HttpError(400, `idempotent() wraps mutating methods only, got ${req.method}`, "Bad request.");
  }

  const key = req.headers.get("idempotency-key");
  if (key === null) {
    // SPEC 2E: never silently allowed. A mutating endpoint without a key is a mutating endpoint
    // whose retries duplicate, and the caller cannot be told that after the fact.
    throw new HttpError(400, "missing Idempotency-Key", "Idempotency-Key header is required.");
  }
  if (!isValidIdempotencyKey(key)) {
    throw new HttpError(400, "malformed Idempotency-Key", "Idempotency-Key must be a ULID or a UUID.");
  }

  let body: unknown;
  try {
    const text = await req.text();
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    throw new HttpError(400, "body is not JSON", "Malformed request body.");
  }

  const hash = await requestHash(body);
  const row = { orgId: ctx.orgId, operation, key };
  const claim = await store.claim({ ...row, requestHash: hash });

  switch (claim.status) {
    case "replay":
      // The stored response, byte for byte. The handler is not called, so whatever it would
      // have done a second time does not happen a second time.
      return new Response(claim.response.body, {
        status: claim.response.status,
        headers: { "content-type": claim.response.contentType, "idempotent-replay": "true" },
      });

    case "mismatch":
      throw new HttpError(
        409,
        "idempotency key reused with a different body",
        "This Idempotency-Key was already used for a different request.",
      );

    case "in_flight":
      // Another request holds this key and has not finished. Returning the first one's result
      // is impossible — there isn't one yet — and running the handler again is the duplicate
      // this whole file exists to prevent. So: refuse, and let the client retry the same key.
      throw new HttpError(
        409,
        "a request with this Idempotency-Key is still in flight",
        "This request is already being processed. Retry with the same Idempotency-Key.",
      );

    case "claimed":
      break;
  }

  let res: Response;
  try {
    res = await run(body);
  } catch (err) {
    // The row must not survive a handler that did nothing, or the caller's honest retry is
    // answered with a replay of a request that never happened.
    await store.release(row);
    throw err;
  }

  const text = await res.clone().text();
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_STORED_RESPONSE_BYTES) {
    // 0003 caps the stored response at 64 KB with a check constraint. Discovering that as a
    // constraint violation AFTER the handler has already changed state is the worst moment to
    // discover it, so the row is released and the response is still returned: the work
    // happened, and the caller is told it cannot be replayed.
    await store.release(row);
    const headers = new Headers(res.headers);
    headers.set("idempotent-stored", "false");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  await store.complete(row, {
    status: res.status,
    body: text,
    contentType: res.headers.get("content-type") ?? "application/json",
  });
  return res;
}
