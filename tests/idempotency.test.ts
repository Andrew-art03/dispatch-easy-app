/**
 * EZ-BUILD-01 Slice 5 (ticket 2E) — a retry is not a second load.
 *
 * SPEC 2E's four cases each have a named test below, and the one that matters most is proved
 * with a side-effect counter rather than asserted: **the handler does not run again.** A replay
 * that returns the right bytes while quietly booking a second load would pass every test that
 * only looks at the response.
 *
 * The store here is an in-memory reference implementation. It is deliberately written the way
 * the database enforces it — one claim operation that inserts or reports the conflict, never a
 * read followed by a write — so a test that passes against it is a test that describes what
 * `(org_id, operation, key)` as a PRIMARY KEY actually does.
 */
import { describe, expect, it, vi } from "vitest";

import { HttpError, type RequestContext } from "../supabase/functions/_shared/context.ts";
import {
  MAX_STORED_RESPONSE_BYTES,
  type ClaimResult,
  type IdempotencyStore,
  type StoredResponse,
  canonicalJson,
  idempotent,
  isMutating,
  isValidIdempotencyKey,
  requestHash,
} from "../supabase/functions/_shared/idempotent.ts";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const KEY = "01JBXR4Q2M8NQ7V3K5ZGABCDEF";
const KEY2 = "01JBXR4Q2M8NQ7V3K5ZGABCDEG";

const ctx = (orgId = ORG_A): RequestContext => ({
  requestId: "req-1",
  authUserId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  orgId,
  userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  role: "owner",
});

/** The primary key, as a Map. One claim operation; no read-then-write anywhere. */
function memoryStore(): IdempotencyStore & { rows: Map<string, { hash: string; response?: StoredResponse }> } {
  const rows = new Map<string, { hash: string; response?: StoredResponse }>();
  const pk = (r: { orgId: string; operation: string; key: string }) => `${r.orgId}|${r.operation}|${r.key}`;
  return {
    rows,
    claim: async (row): Promise<ClaimResult> => {
      const id = pk(row);
      const existing = rows.get(id);
      if (!existing) {
        rows.set(id, { hash: row.requestHash });
        return { status: "claimed" };
      }
      if (existing.hash !== row.requestHash) return { status: "mismatch" };
      return existing.response ? { status: "replay", response: existing.response } : { status: "in_flight" };
    },
    complete: async (row, response) => {
      const existing = rows.get(pk(row));
      if (existing) existing.response = response;
    },
    release: async (row) => {
      rows.delete(pk(row));
    },
  };
}

const post = (body: unknown, key: string | null = KEY, method = "POST") =>
  new Request("https://ez.example/loads", {
    method,
    headers: {
      ...(key === null ? {} : { "idempotency-key": key }),
      "content-type": "application/json",
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });

/** A handler that counts how many times it actually ran. This counter IS the proof. */
function countingHandler(result: unknown = { id: "load-1" }) {
  let runs = 0;
  const handler = async () => {
    runs += 1;
    return new Response(JSON.stringify(result), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  return { handler, runs: () => runs };
}

describe("SPEC 2E case 1 — the same request twice is one row and one response", () => {
  it("returns the stored response and does NOT run the handler again", async () => {
    const store = memoryStore();
    const { handler, runs } = countingHandler();
    const body = { rate_cents: 280000, reference: "ABC-1" };

    const first = await idempotent(ctx(), post(body), "loads.create", store, handler);
    const second = await idempotent(ctx(), post(body), "loads.create", store, handler);

    expect(runs()).toBe(1); // the whole promise of the file
    expect(store.rows.size).toBe(1);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    await expect(second.json()).resolves.toEqual({ id: "load-1" });
    expect(second.headers.get("idempotent-replay")).toBe("true");
  });

  it("replays byte for byte, not a re-serialisation that happens to look similar", async () => {
    const store = memoryStore();
    let n = 0;
    const handler = async () =>
      new Response(JSON.stringify({ seq: (n += 1) }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    await idempotent(ctx(), post({ a: 1 }), "loads.create", store, handler);
    const replay = await idempotent(ctx(), post({ a: 1 }), "loads.create", store, handler);
    // If the handler had re-run, this would be 2.
    await expect(replay.json()).resolves.toEqual({ seq: 1 });
  });

  it("key order in the body does not matter — the hash is canonical", async () => {
    const store = memoryStore();
    const { handler, runs } = countingHandler();
    await idempotent(ctx(), post({ a: 1, b: 2 }), "loads.create", store, handler);
    await idempotent(ctx(), post({ b: 2, a: 1 }), "loads.create", store, handler);
    expect(runs()).toBe(1);
  });
});

describe("SPEC 2E case 2 — two concurrent identical requests produce one row", () => {
  it("the loser is refused rather than run a second time", async () => {
    const store = memoryStore();
    const { handler: slow, runs } = (() => {
      let n = 0;
      return {
        handler: async () => {
          n += 1;
          await new Promise((r) => setTimeout(r, 10));
          return new Response(JSON.stringify({ id: "load-1" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        },
        runs: () => n,
      };
    })();

    const a = idempotent(ctx(), post({ x: 1 }), "loads.create", store, slow);
    const b = idempotent(ctx(), post({ x: 1 }), "loads.create", store, slow);
    const [first, second] = await Promise.allSettled([a, b]);

    expect(runs()).toBe(1);
    expect(store.rows.size).toBe(1);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    // In flight, not a mismatch: the body was identical. Retrying the SAME key is the right
    // next move and the message says so.
    expect((second as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
  });
});

describe("SPEC 2E case 3 — same key, different body is 409", () => {
  it("refuses, and does not run the handler", async () => {
    const store = memoryStore();
    const { handler, runs } = countingHandler();
    await idempotent(ctx(), post({ rate_cents: 280000 }), "loads.create", store, handler);

    await expect(
      idempotent(ctx(), post({ rate_cents: 310000 }), "loads.create", store, handler),
    ).rejects.toMatchObject({ status: 409 });

    expect(runs()).toBe(1);
    expect(store.rows.size).toBe(1);
  });

  it("a single changed cent is a different body", async () => {
    const store = memoryStore();
    const { handler } = countingHandler();
    await idempotent(ctx(), post({ rate_cents: 280000 }), "loads.create", store, handler);
    await expect(
      idempotent(ctx(), post({ rate_cents: 280001 }), "loads.create", store, handler),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("SPEC 2E case 4 — a missing header is 400, never silently allowed", () => {
  it("refuses a mutating request with no Idempotency-Key", async () => {
    const store = memoryStore();
    const { handler, runs } = countingHandler();
    await expect(idempotent(ctx(), post({ a: 1 }, null), "loads.create", store, handler)).rejects.toMatchObject({
      status: 400,
    });
    expect(runs()).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it("refuses a key that is not a ULID or a UUID", async () => {
    const store = memoryStore();
    const { handler } = countingHandler();
    for (const bad of ["", "retry-1", "../../etc/passwd", "01JBXR4Q2M8NQ7V3K5ZGABCDE", "x".repeat(26)]) {
      await expect(idempotent(ctx(), post({ a: 1 }, bad), "loads.create", store, handler)).rejects.toMatchObject({
        status: 400,
      });
    }
  });

  it("accepts a ULID and a UUID, and rejects anything carrying an invisible character", () => {
    expect(isValidIdempotencyKey(KEY)).toBe(true);
    expect(isValidIdempotencyKey("11111111-1111-1111-1111-111111111111")).toBe(true);
    expect(isValidIdempotencyKey("01JBXR4Q2M8NQ7V3K5ZGABCDE​")).toBe(false);
    // Crockford base32 excludes I, L, O and U precisely so they cannot be confused with 1 and 0.
    expect(isValidIdempotencyKey("01JBXR4Q2M8NQ7V3K5ZGABCDEI")).toBe(false);
  });

  it("wraps mutating methods only — a GET has nothing to replay", async () => {
    const store = memoryStore();
    const { handler } = countingHandler();
    await expect(
      idempotent(ctx(), post(undefined, KEY, "GET"), "loads.read", store, handler),
    ).rejects.toMatchObject({ status: 400 });
    expect(isMutating("POST")).toBe(true);
    expect(isMutating("patch")).toBe(true);
    expect(isMutating("DELETE")).toBe(true);
    expect(isMutating("GET")).toBe(false);
    expect(isMutating("HEAD")).toBe(false);
  });
});

describe("the key is scoped to a tenant and an operation, per the primary key", () => {
  it("the same key in two orgs is two different rows", async () => {
    // (org_id, operation, key). Without org_id in the PK, one tenant could deny another tenant
    // an action by guessing a ULID — and ULIDs are not secret, they are just unique.
    const store = memoryStore();
    const { handler, runs } = countingHandler();
    await idempotent(ctx(ORG_A), post({ a: 1 }), "loads.create", store, handler);
    await idempotent(ctx(ORG_B), post({ a: 1 }), "loads.create", store, handler);
    expect(runs()).toBe(2);
    expect(store.rows.size).toBe(2);
  });

  it("the same key on two operations is two different rows", async () => {
    const store = memoryStore();
    const { handler, runs } = countingHandler();
    await idempotent(ctx(), post({ a: 1 }), "loads.create", store, handler);
    await idempotent(ctx(), post({ a: 1 }), "deal.approve", store, handler);
    expect(runs()).toBe(2);
  });

  it("a different key is a different action, even with an identical body", async () => {
    const store = memoryStore();
    const { handler, runs } = countingHandler();
    await idempotent(ctx(), post({ a: 1 }, KEY), "loads.create", store, handler);
    await idempotent(ctx(), post({ a: 1 }, KEY2), "loads.create", store, handler);
    // Two taps the driver meant. Idempotency is about retries of ONE action, not about
    // preventing a carrier from booking two identical loads.
    expect(runs()).toBe(2);
  });
});

describe("a handler that fails does not leave a row behind", () => {
  it("releases the claim, so an honest retry is not answered with a replay of nothing", async () => {
    const store = memoryStore();
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("downstream timeout");
      return new Response(JSON.stringify({ id: "load-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(idempotent(ctx(), post({ a: 1 }), "loads.create", store, flaky)).rejects.toThrow("downstream timeout");
    expect(store.rows.size).toBe(0);

    const retry = await idempotent(ctx(), post({ a: 1 }), "loads.create", store, flaky);
    expect(retry.status).toBe(201);
    expect(attempts).toBe(2);
  });

  it("a response too large to store is still returned, and says it was not stored", async () => {
    // 0003 caps the stored response at 64 KB. Discovering that as a constraint violation AFTER
    // the handler has already changed state is the worst possible moment to discover it.
    const store = memoryStore();
    const big = "x".repeat(MAX_STORED_RESPONSE_BYTES + 1);
    const res = await idempotent(ctx(), post({ a: 1 }), "loads.create", store, async () =>
      new Response(big, { status: 200, headers: { "content-type": "text/plain" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-stored")).toBe("false");
    expect(store.rows.size).toBe(0);
  });
});

describe("the request hash: canonical, and no header is ever mixed into it", () => {
  it("is stable across key order at every depth", async () => {
    const a = await requestHash({ b: { d: 1, c: 2 }, a: [3, { f: 1, e: 2 }] });
    const b = await requestHash({ a: [3, { e: 2, f: 1 }], b: { c: 2, d: 1 } });
    expect(a).toBe(b);
  });

  it("distinguishes values that JSON.stringify would flatten together", async () => {
    // NaN and Infinity both stringify to `null`, so {rate: NaN} and {rate: null} would hash
    // identically — two different requests sharing one idempotency row, on the money path.
    expect(() => canonicalJson({ rate: Number.NaN })).toThrow(HttpError);
    expect(() => canonicalJson({ rate: Number.POSITIVE_INFINITY })).toThrow(HttpError);
    await expect(requestHash({ rate: null })).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats -0 and 0 as the same number, because a rate does not have a sign of zero", () => {
    expect(canonicalJson({ cents: -0 })).toBe(canonicalJson({ cents: 0 }));
  });

  it("drops undefined, so a parsed body and a constructed body agree", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("distinguishes an array's order, which is not key order", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("ignores headers entirely — including trace headers and the key itself", async () => {
    // SPEC 2E's "minus Idempotency-Key / timestamps / trace headers" is satisfied by nothing
    // from the headers being a candidate in the first place. The alternative reading — strip
    // body FIELDS named like metadata — is rejected in the file's header, because a payload
    // with a real business field named `timestamp` would then make two different requests hash
    // the same, and hand the second one the first one's response as a success.
    const store = memoryStore();
    const { handler, runs } = countingHandler();
    const withTrace = new Request("https://ez.example/loads", {
      method: "POST",
      headers: {
        "idempotency-key": KEY,
        "content-type": "application/json",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "x-request-id": "01JBXR4Q2M8NQ7V3K5ZG",
        date: "Sun, 14 Sep 2026 04:00:00 GMT",
      },
      body: JSON.stringify({ a: 1 }),
    });
    await idempotent(ctx(), post({ a: 1 }), "loads.create", store, handler);
    const replay = await idempotent(ctx(), withTrace, "loads.create", store, handler);
    expect(runs()).toBe(1);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
  });

  it("a body field named `timestamp` DOES change the hash — it is business data, not metadata", async () => {
    const store = memoryStore();
    const { handler, runs } = countingHandler();
    await idempotent(ctx(), post({ timestamp: "2026-09-14T04:00:00Z" }), "loads.create", store, handler);
    await expect(
      idempotent(ctx(), post({ timestamp: "2026-09-14T05:00:00Z" }), "loads.create", store, handler),
    ).rejects.toMatchObject({ status: 409 });
    expect(runs()).toBe(1);
  });

  it("is a sha256, and an empty body has one too", async () => {
    await expect(requestHash(null)).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(requestHash({})).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(await requestHash(null)).not.toBe(await requestHash({}));
  });

  it("a body that is not JSON is 400, and the handler does not run", async () => {
    const store = memoryStore();
    const handler = vi.fn(async () => new Response("{}"));
    const bad = new Request("https://ez.example/loads", {
      method: "POST",
      headers: { "idempotency-key": KEY, "content-type": "application/json" },
      body: "{not json",
    });
    await expect(idempotent(ctx(), bad, "loads.create", store, handler)).rejects.toMatchObject({ status: 400 });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("2E's structural invariants, asserted on the file itself", () => {
  const read = async (rel: string) => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    return readFileSync(`${fileURLToPath(new URL("..", import.meta.url))}${rel}`, "utf8");
  };

  it("holds no database client of its own", async () => {
    const src = await read("supabase/functions/_shared/idempotent.ts");
    expect(src).not.toContain("@supabase/supabase-js");
    for (const line of src.split("\n").filter((l) => /createClient|createDb/.test(l))) {
      expect(line.trim().startsWith("*") || line.trim().startsWith("//")).toBe(true);
    }
  });

  it("the store interface has no read-then-write shape for a caller to misuse", async () => {
    // `claim` is one operation. If the interface offered `get` and `insert` separately, the
    // obvious implementation would have a window between them exactly the width of a second tap.
    const src = await read("supabase/functions/_shared/idempotent.ts");
    expect(src).toContain("readonly claim:");
    expect(src).not.toMatch(/readonly (get|find|lookup|exists):/);
  });

  it("the 64 KB cap here is the same number the migration enforces", async () => {
    expect(MAX_STORED_RESPONSE_BYTES).toBe(65536);
    const migration = await read("supabase/migrations/0003_hardening_and_runtime.sql");
    expect(migration).toContain("octet_length(response::text) <= 65536");
  });
});
