/**
 * EZ-BUILD-01 Slice 4 (ticket 2D) — the request context, and the one negative it exists for.
 *
 * SPEC 2D's named test is the third describe block: body `{org_id: B}` under user A is ignored
 * and `ctx.orgId` is A. It is written here in more shapes than the spec asks for — body, query
 * string, header, and a JWT claim — because the interesting failure is not "the body was
 * trusted" but "some OTHER part of the request was trusted after the body was handled".
 */
import { describe, expect, it, vi } from "vitest";

import {
  CAPABILITIES,
  GRANTED_TO_NOBODY,
  ROLE_CAPS,
  hasCapability,
  requireCapability,
} from "../supabase/functions/_shared/authz.ts";
import {
  HttpError,
  ROLES,
  type ContextDeps,
  type RequestContext,
  type Role,
  type UserRow,
  bearerToken,
  buildContext,
  sanitizeRequestId,
  withContext,
} from "../supabase/functions/_shared/context.ts";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const userA: UserRow = { id: USER_A, org_id: ORG_A, role: "owner" };

/** A verifier that accepts exactly one token, which is what an anon-client verify does. */
const deps = (over: Partial<ContextDeps> = {}): ContextDeps => ({
  verifyJwt: async (jwt) => (jwt === "good" ? { sub: USER_A } : null),
  loadUser: async (id) => (id === USER_A ? userA : null),
  newRequestId: () => "req-generated",
  ...over,
});

const request = (init: { auth?: string; headers?: Record<string, string>; body?: unknown; url?: string } = {}) =>
  new Request(init.url ?? "https://ez.example/loads", {
    method: "POST",
    headers: {
      ...(init.auth === undefined ? { authorization: "Bearer good" } : init.auth === "" ? {} : { authorization: init.auth }),
      ...(init.headers ?? {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(init.body ?? {}),
  });

const ctxA: RequestContext = {
  requestId: "req-1",
  authUserId: USER_A,
  orgId: ORG_A,
  userId: USER_A,
  role: "owner",
};

describe("the JWT is verified, and a refusal is a refusal", () => {
  it("a valid token produces a context whose org comes from the user row", async () => {
    const ctx = await buildContext(request(), deps());
    expect(ctx).toEqual({
      requestId: "req-generated",
      authUserId: USER_A,
      orgId: ORG_A,
      userId: USER_A,
      role: "owner",
    });
  });

  it("no Authorization header is 401", async () => {
    await expect(buildContext(request({ auth: "" }), deps())).rejects.toMatchObject({ status: 401 });
  });

  it("a token that does not verify is 401", async () => {
    await expect(buildContext(request({ auth: "Bearer stale" }), deps())).rejects.toMatchObject({ status: 401 });
  });

  it("a verifier that THROWS is still a 401, never a 500", async () => {
    // The difference between "your token is bad" and "the server is broken" is information an
    // attacker can use to tell a rejected token from a rejected request.
    const boom = deps({
      verifyJwt: async () => {
        throw new Error("network");
      },
    });
    await expect(buildContext(request(), boom)).rejects.toMatchObject({ status: 401 });
  });

  it("a valid token with no user row is 403 — authenticated is not known", async () => {
    // SPEC 2D, and the branch that cannot be exercised against a live Supabase: an account
    // that exists in auth.users and nowhere else belongs to no org, and there is no safe
    // default org to invent for it.
    const orphan = deps({ loadUser: async () => null });
    await expect(buildContext(request(), orphan)).rejects.toMatchObject({ status: 403 });
  });

  it("a user row for a different subject is 403, not silently adopted", async () => {
    const wrong = deps({ loadUser: async () => ({ ...userA, id: "somebody-else" }) });
    await expect(buildContext(request(), wrong)).rejects.toMatchObject({ status: 403 });
  });

  it("a role the code does not know is 403, not downgraded to the smallest role", async () => {
    // Failing closed on a value from the database costs a request. Guessing costs a boundary.
    const odd = deps({ loadUser: async () => ({ ...userA, role: "superuser" as unknown as Role }) });
    await expect(buildContext(request(), odd)).rejects.toMatchObject({ status: 403 });
  });

  it("only `Bearer <token>` parses, and nothing else does", () => {
    expect(bearerToken("Bearer abc.def-ghi")).toBe("abc.def-ghi");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken("Bearer <script>")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe("R-6: tenant comes from identity, never from the request", () => {
  it("body {org_id: B} under user A is ignored, and ctx.orgId is A", async () => {
    // SPEC 2D's named negative, verbatim.
    const ctx = await buildContext(request({ body: { org_id: ORG_B, orgId: ORG_B, tenant: ORG_B } }), deps());
    expect(ctx.orgId).toBe(ORG_A);
  });

  it("a query string cannot set it either", async () => {
    const ctx = await buildContext(request({ url: `https://ez.example/loads?org_id=${ORG_B}` }), deps());
    expect(ctx.orgId).toBe(ORG_A);
  });

  it("nor can a header that looks official", async () => {
    const ctx = await buildContext(
      request({ headers: { "x-org-id": ORG_B, "x-tenant": ORG_B, "x-ez-org": ORG_B } }),
      deps(),
    );
    expect(ctx.orgId).toBe(ORG_A);
  });

  it("nor can a JWT claim, even one the verifier hands over", async () => {
    // An access-token hook could one day emit an org claim. It still is not where org comes
    // from: the user row is, because that is the only value the tenant cannot edit.
    const claimful = deps({
      verifyJwt: async () => ({ sub: USER_A, org_id: ORG_B }) as unknown as { sub: string },
    });
    const ctx = await buildContext(request(), claimful);
    expect(ctx.orgId).toBe(ORG_A);
  });

  it("the body is never even read while building the context", async () => {
    // Stronger than "the body is ignored": there is no code path from a body to a context, so
    // the request stream is still unconsumed when the handler receives it.
    const req = request({ body: { org_id: ORG_B } });
    await buildContext(req, deps());
    expect(req.bodyUsed).toBe(false);
    await expect(req.json()).resolves.toEqual({ org_id: ORG_B });
  });
});

describe("the request id is a log correlator, and is treated as untrusted text", () => {
  it("a well-shaped client id is kept, so a caller can correlate its own retries", () => {
    expect(sanitizeRequestId("01JBXR4Q2M8NQ7V3K5ZG", () => "gen")).toBe("01JBXR4Q2M8NQ7V3K5ZG");
  });

  it("a newline cannot be smuggled in to forge a log line", () => {
    expect(sanitizeRequestId("ok\n2026-09-14 FATAL wiped", () => "gen")).toBe("gen");
  });

  it("invisible and tag characters are rejected, not quietly stripped (rule 46)", () => {
    // Quietly stripping accepts a value that was only acceptable because something was hiding
    // in it. There is no reason a legitimate correlation id contains a bidi override.
    expect(sanitizeRequestId("abcdefgh‮", () => "gen")).toBe("gen");
    expect(sanitizeRequestId("abcdefgh​", () => "gen")).toBe("gen");
    expect(sanitizeRequestId("abcdefgh󠁁", () => "gen")).toBe("gen");
  });

  it("anything over-long, empty or oddly punctuated falls back to a generated one", () => {
    expect(sanitizeRequestId("x".repeat(65), () => "gen")).toBe("gen");
    expect(sanitizeRequestId("short", () => "gen")).toBe("gen");
    expect(sanitizeRequestId("has spaces here", () => "gen")).toBe("gen");
    expect(sanitizeRequestId(null, () => "gen")).toBe("gen");
  });
});

describe("withContext is the single wrapper, and it leaks nothing", () => {
  it("passes the context to the handler and stamps x-request-id on the response", async () => {
    const res = await withContext(request(), deps(), async (ctx) =>
      new Response(JSON.stringify({ org: ctx.orgId }), { status: 200 }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-generated");
    await expect(res.json()).resolves.toEqual({ org: ORG_A });
  });

  it("turns a refusal into its status with a body that names nothing", async () => {
    const res = await withContext(request({ auth: "Bearer stale" }), deps(), async () => new Response("unreachable"));
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain(ORG_A);
    expect(body).not.toContain(USER_A);
    expect(body).not.toContain("stale");
  });

  it("a handler that throws is a 500 that says nothing about why", async () => {
    // An unexpected error may hold a connection string, a row, or half a JWT (rule 6).
    const res = await withContext(request(), deps(), async () => {
      throw new Error("connect ECONNREFUSED postgres://user:hunter2@db:5432");
    });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("postgres://");
    expect(res.headers.get("x-request-id")).toBe("req-generated");
  });

  it("the handler does not run at all when the context cannot be built", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    await withContext(request({ auth: "" }), deps(), handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a refusal still carries a request id, so the 403 is findable in a log", async () => {
    const res = await withContext(request({ auth: "" }), deps(), async () => new Response("ok"));
    expect(res.headers.get("x-request-id")).toBe("req-generated");
  });
});

describe("capabilities: authenticated is not allowed", () => {
  it("every role in the matrix is a role the context can produce, and vice versa", () => {
    expect(Object.keys(ROLE_CAPS).sort()).toEqual([...ROLES].sort());
  });

  it("every capability granted anywhere is a declared capability", () => {
    for (const caps of Object.values(ROLE_CAPS)) {
      for (const c of caps) expect(CAPABILITIES).toContain(c);
    }
  });

  it("admin.kill_switch is granted to NO role, owner included", () => {
    // The rule-37 switch is is_founder() in the database: a pinned auth uid AND an
    // app_metadata flag. Every carrier who signs up is an owner of their own org, so an
    // owner-gated kill switch is a kill switch every customer can disable.
    for (const role of ROLES) expect(ROLE_CAPS[role]).not.toContain("admin.kill_switch");
    expect(GRANTED_TO_NOBODY).toContain("admin.kill_switch");
  });

  it("ledger.write is granted to NO role either", () => {
    // insert on ledger_line is revoked from authenticated, anon AND service_role in 0003.
    // Money is written by execute_approved_action after consume_approval, and by nothing else.
    for (const role of ROLES) expect(ROLE_CAPS[role]).not.toContain("ledger.write");
    expect(GRANTED_TO_NOBODY).toContain("ledger.write");
  });

  it("a driver cannot transition a load (rules 16 and 34)", () => {
    // Driving mode is read-only. Moving a load's state is a decision, and a decision made at
    // 65 mph is the thing rule 16 exists to prevent.
    expect(ROLE_CAPS.driver).not.toContain("load.transition");
    expect(ROLE_CAPS.driver).not.toContain("deal.approve");
    expect(ROLE_CAPS.driver).not.toContain("load.create");
  });

  it("a driver CAN read, upload a document and confirm by voice", () => {
    expect(ROLE_CAPS.driver).toContain("load.read");
    expect(ROLE_CAPS.driver).toContain("document.upload");
    expect(ROLE_CAPS.driver).toContain("call.confirm");
  });

  it("requireCapability throws 403 and grants nothing on a near miss", () => {
    const driver: RequestContext = { ...ctxA, role: "driver" };
    expect(() => requireCapability(driver, "load.read")).not.toThrow();
    expect(() => requireCapability(driver, "load.transition")).toThrow(HttpError);
    try {
      requireCapability(driver, "load.transition");
    } catch (e) {
      expect((e as HttpError).status).toBe(403);
      // The caller learns it is not permitted and nothing else about the system.
      expect((e as HttpError).publicMessage).toBe("Not permitted.");
      expect((e as HttpError).publicMessage).not.toContain(ORG_A);
    }
  });

  it("hasCapability is false for a role that is not in the matrix at all", () => {
    const alien: RequestContext = { ...ctxA, role: "auditor" as unknown as Role };
    expect(hasCapability(alien, "load.read")).toBe(false);
    expect(() => requireCapability(alien, "load.read")).toThrow(HttpError);
  });
});

describe("2D's structural invariants, asserted on the files themselves", () => {
  const read = async (rel: string) => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    return readFileSync(`${fileURLToPath(new URL("..", import.meta.url))}${rel}`, "utf8");
  };

  it("the shared context never constructs a Supabase client", async () => {
    // Rule 40: createDb() in packages/config/db.ts is the only factory, and check:db-boundary
    // fails anything else that imports the package. Taking the two operations it needs as
    // injected functions satisfies that structurally rather than by promising to behave.
    for (const f of ["supabase/functions/_shared/context.ts", "supabase/functions/_shared/authz.ts"]) {
      const src = await read(f);
      expect(src).not.toContain("@supabase/supabase-js");
      // Line-based, not substring-based: the header of context.ts explains WHY it never builds
      // a client, and a blunt `not.toContain("createDb")` makes explaining the rule a violation
      // of it. The rule is about code. Every mention has to be in a comment.
      for (const line of src.split("\n").filter((l) => /createClient|createDb/.test(l))) {
        expect(line.trim().startsWith("*") || line.trim().startsWith("//"), `code line: ${line.trim()}`).toBe(true);
      }
    }
  });

  it("and it never reads a secret or an environment variable", async () => {
    const src = await read("supabase/functions/_shared/context.ts");
    expect(src).not.toMatch(/process\s*\.\s*env/);
    expect(src).not.toMatch(/Deno\s*\.\s*env/);
    expect(src).not.toMatch(/SERVICE_ROLE/);
  });

  it("the service role is named only in the comment that forbids it", async () => {
    // SPEC 2D: verification uses the anon client. A service-role client answers every question
    // with "yes, you're allowed", so using one to decide whether a caller is allowed is not a
    // check — it is a formality.
    const src = await read("supabase/functions/_shared/context.ts");
    const mentions = src.match(/service.role/gi) ?? [];
    expect(mentions.length).toBeGreaterThan(0);
    for (const line of src.split("\n").filter((l) => /service.role/i.test(l))) {
      expect(line.trim().startsWith("*") || line.trim().startsWith("//")).toBe(true);
    }
  });

  it("createDb('privileged') still refuses, so no endpoint can quietly acquire one", async () => {
    // 1B's allowlist is empty by design (1F/H-8), and 2D's technical invariant (b) depends on
    // it staying that way. Asserted here rather than assumed because 2D is the ticket that
    // would find it convenient to add a name.
    const src = await read("packages/config/db.ts");
    expect(src).toMatch(/const PRIVILEGED_CALLERS = new Set<string>\(\[\]\)/);
  });
});
