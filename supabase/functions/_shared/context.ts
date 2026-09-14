/**
 * EZ-BUILD-01 Slice 4 (ticket 2D) — one request context, built from identity and nothing else.
 *
 * THE RULE THIS FILE IS. `org_id` comes only from the authenticated user's row. Not from the
 * body, not from a header, not from a query string, not from a JWT claim an access-token hook
 * might one day emit. BUILD_DEFAULTS R-6, and SPEC 2B's one-line version: "tenant is derived
 * from identity, never from the request."
 *
 * WHY THE DEPENDENCIES ARE INJECTED RATHER THAN IMPORTED. Three reasons, in order of how much
 * they matter:
 *
 *   1. `createDb()` in packages/config/db.ts is the single client factory (rule 40), and
 *      `check:db-boundary` fails any other module that constructs a Supabase client. Taking
 *      the two operations this file needs as functions means it never holds a client at all,
 *      so the rule is satisfied structurally instead of by this file promising to behave.
 *   2. It makes every branch here testable under vitest with no database and no network. The
 *      branch that matters most — "a valid JWT whose user row does not exist is 403, not a
 *      guess" — is exactly the one that is impossible to exercise against a live Supabase.
 *   3. This is Deno/Edge code living in a Vite project. Zero Deno APIs appear below, so `tsc`
 *      covers it today; the thin Deno entry that supplies the real dependencies lands with the
 *      first endpoint (Slice 8), not before there is anything to serve.
 *
 * WHAT VERIFIES THE TOKEN. `verifyJwt` must be implemented with the **anon** client. Never the
 * service role: a service-role client answers every question with "yes, you're allowed", so
 * using one to decide whether a caller is allowed is not a check, it is a formality. SPEC 2D
 * says this in one clause; it is repeated here because this is the file where it would be
 * convenient to get wrong.
 */

export type Role = "owner" | "dispatcher" | "driver";

export interface RequestContext {
  /** Correlates every log line, audit row and downstream call for one request. */
  readonly requestId: string;
  /** `auth.users.id`. In this schema it is also the `user` table's primary key. */
  readonly authUserId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly role: Role;
}

/** The `user` row this context is built from. Only these four fields are ever read. */
export interface UserRow {
  readonly id: string;
  readonly org_id: string;
  readonly role: Role;
}

export interface ContextDeps {
  /**
   * Verify the bearer token and return its subject, or null for anything invalid — expired,
   * malformed, wrong audience, wrong signature. **Implemented with the anon client.**
   * Null and throw are both refusals; a thrown error must never reach the caller as a 500,
   * because "the token is bad" and "the server is broken" are different answers.
   */
  readonly verifyJwt: (jwt: string) => Promise<{ sub: string } | null>;
  /** The user row for an auth uid, or null when there is none. */
  readonly loadUser: (authUserId: string) => Promise<UserRow | null>;
  /** Request id generator. Injected so tests are deterministic. */
  readonly newRequestId: () => string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    override readonly message: string,
    /** Safe to send to the caller. Never contains a token, an org id or a user id. */
    readonly publicMessage: string = message,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Ranges of code points that must never appear in a value destined for a log line: C0 and C1
 * controls, zero-width and bidi marks, the two line separators, the invisible-operator block,
 * the BOM, interlinear annotation, and the Unicode tag block used to hide text inside text.
 *
 * Written as NUMBERS, not as a regular-expression character class. A class built from \u
 * escapes is a class one careless save turns into the literal characters themselves -- and
 * U+2028 IS a line terminator, so the regex literal silently stops being a regex literal.
 * That happened while writing this file, and the parse error named a line that looked fine.
 * Numbers cannot be decoded by accident.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f], // C0 controls, including newline and carriage return
  [0x007f, 0x009f], // DEL and the C1 controls
  [0x200b, 0x200f], // zero-width space/joiner, LRM/RLM
  [0x2028, 0x202e], // line/paragraph separator, and the bidi overrides
  [0x2060, 0x206f], // word joiner, invisible operators, deprecated format characters
  [0xfff9, 0xfffb], // interlinear annotation
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0xe0000, 0xe007f], // Unicode tag characters -- text hidden inside text (rule 46)
];

export function hasInvisible(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    for (const [lo, hi] of INVISIBLE_RANGES) {
      if (cp >= lo && cp <= hi) return true;
    }
  }
  return false;
}

/**
 * A client-supplied request id is a log correlator and nothing more, so it is accepted only in
 * a shape that cannot do anything else. Rules 45/46: untrusted text is data -- and text that
 * reaches a log file can forge a log line if it carries a newline, or hide one if it carries a
 * bidi override or a tag character.
 *
 * Anything invisible is REJECTED, not stripped. Stripping accepts a value that was only
 * acceptable because something was hiding in it.
 */
export function sanitizeRequestId(raw: string | null, fallback: () => string): string {
  if (raw === null) return fallback();
  if (hasInvisible(raw)) return fallback();
  return SAFE_REQUEST_ID.test(raw) ? raw : fallback();
}

/** The request id for one request, resolved exactly once. */
export function resolveRequestId(req: Request, deps: ContextDeps): string {
  return sanitizeRequestId(req.headers.get("x-request-id"), deps.newRequestId);
}

/** `Bearer <token>`, case-insensitive on the scheme, with no room for anything else. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer[ ]([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

/**
 * Build the context for a request, or throw an HttpError describing the refusal.
 *
 * The body is deliberately not a parameter. There is no code path from a request body to a
 * `RequestContext`, which is stronger than a code path that exists and is careful.
 */
export async function buildContext(
  req: Request,
  deps: ContextDeps,
  /**
   * Supplied by withContext, which resolves it BEFORE this function can refuse. A 401 or a 403
   * with no request id is a refusal nobody can find in a log afterwards, and deps.newRequestId
   * is not required to be deterministic -- calling it again here would mint a second id for
   * the same request. Caught by its own test rather than in production.
   */
  requestIdIn?: string,
): Promise<RequestContext> {
  const requestId = requestIdIn ?? resolveRequestId(req, deps);

  const token = bearerToken(req.headers.get("authorization"));
  if (!token) {
    throw new HttpError(401, "no bearer token", "Authentication required.");
  }

  let subject: { sub: string } | null;
  try {
    subject = await deps.verifyJwt(token);
  } catch {
    // A verifier that throws is still just saying no. Letting that become a 500 would tell an
    // attacker the difference between a rejected token and a broken server.
    subject = null;
  }
  if (!subject?.sub) {
    throw new HttpError(401, "jwt did not verify", "Authentication required.");
  }

  const user = await deps.loadUser(subject.sub);
  if (!user) {
    // Authenticated is not the same as known. A valid Supabase account with no `user` row
    // belongs to no org, and there is no safe default org to invent for it.
    throw new HttpError(403, `no user row for auth uid`, "This account is not set up for any organisation.");
  }
  if (user.id !== subject.sub) {
    throw new HttpError(403, "user row does not belong to the authenticated subject", "Not permitted.");
  }
  if (!ROLES.includes(user.role)) {
    // An unknown role gets no capabilities at all, rather than the smallest set. Failing closed
    // on a value from the database costs a request; guessing costs a boundary.
    throw new HttpError(403, `unknown role`, "Not permitted.");
  }

  return {
    requestId,
    authUserId: subject.sub,
    orgId: user.org_id,
    userId: user.id,
    role: user.role,
  };
}

export const ROLES: readonly Role[] = ["owner", "dispatcher", "driver"];

/**
 * The one wrapper every endpoint goes through. Authorization copied into each handler is
 * authorization that drifts; this is SPEC 2D's stated top failure mode and its prevention.
 */
export async function withContext(
  req: Request,
  deps: ContextDeps,
  handler: (ctx: RequestContext, req: Request) => Promise<Response>,
): Promise<Response> {
  // Resolved first, so EVERY response carries it -- including the ones that never reach a
  // handler. A 403 you cannot find in a log is a 403 nobody can explain to the driver it
  // happened to.
  const requestId = resolveRequestId(req, deps);
  try {
    const ctx = await buildContext(req, deps, requestId);
    const res = await handler(ctx, req);
    return withRequestId(res, ctx.requestId);
  } catch (err) {
    if (err instanceof HttpError) {
      return withRequestId(jsonError(err.status, err.publicMessage), requestId);
    }
    // Nothing from an unexpected error reaches the caller. It may hold a connection string, a
    // row, or half a JWT (rule 6).
    return withRequestId(jsonError(500, "Request failed."), requestId);
  }
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withRequestId(res: Response, requestId: string): Response {
  const headers = new Headers(res.headers);
  headers.set("x-request-id", requestId);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
