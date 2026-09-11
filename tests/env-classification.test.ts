import { describe, expect, it } from "vitest";

import {
  UnknownEnvironment,
  classify,
  refOf,
  refOfJwt,
  resolveEnv,
  type EnvSource,
} from "../packages/config/env.ts";

const PROD_REF = "efeaylkqgqhobookcqby";
const OTHER_REF = "abcdefghijklmnopqrst"; // well-formed, in no allowlist
const SCRATCH_REF = "krwcnieffeasjczkwrlz"; // ez-scratch, allowlisted in 1D

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build a structurally valid JWT. Signature is decorative — refOfJwt does not verify it. */
function jwt(claims: Record<string, unknown>): string {
  return [
    b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    b64url(JSON.stringify(claims)),
    "sig",
  ].join(".");
}

const anonKey = (ref: string) => jwt({ iss: "supabase", role: "anon", ref });

describe("refOf — target shapes it must positively identify", () => {
  it("reads the ref from an api host", () => {
    expect(refOf(`https://${PROD_REF}.supabase.co`)).toEqual({ ref: PROD_REF });
  });

  it("reads the ref from a direct db host", () => {
    expect(refOf(`postgres://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`)).toEqual({
      ref: PROD_REF,
    });
  });

  it("reads the ref from a pooler username, where the hostname has no ref at all", () => {
    expect(
      refOf(`postgres://postgres.${PROD_REF}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`),
    ).toEqual({ ref: PROD_REF });
  });

  it.each(["localhost", "127.0.0.1", "kong", "supabase_kong_ez"])("treats %s as local", (host) => {
    expect(refOf(`http://${host}:54321`)).toEqual({ local: true });
  });

  it("accepts a bare host:port with no scheme", () => {
    expect(refOf("localhost:54321")).toEqual({ local: true });
  });
});

describe("refOf — everything it cannot identify must throw", () => {
  it.each([
    ["a custom domain", "https://db.eztrucking.com"],
    ["a raw IP that is not loopback", "postgres://postgres:pw@10.0.0.5:5432/postgres"],
    [
      "a pooler host with no postgres.<ref> user",
      "postgres://postgres:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    ],
    ["a ref-less supabase.com host", "https://api.supabase.com"],
    ["a short ref", "https://tooshort.supabase.co"],
    ["garbage", "not a url at all !!"],
    ["an empty string", ""],
  ])("throws on %s", (_label, target) => {
    expect(() => refOf(target)).toThrow(UnknownEnvironment);
  });

  it("never puts the raw target in the error message, because a postgres URL carries its password", () => {
    const withPassword = "postgres://postgres:hunter2@db.eztrucking.com:5432/postgres";
    expect(() => refOf(withPassword)).toThrow(/db\.eztrucking\.com/);
    try {
      refOf(withPassword);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("hunter2");
    }
  });
});

describe("refOfJwt — a malformed key must never silently classify", () => {
  it("reads the ref from a well-formed anon key", () => {
    expect(refOfJwt(anonKey(PROD_REF))).toBe(PROD_REF);
  });

  it("accepts a service_role key", () => {
    expect(refOfJwt(jwt({ iss: "supabase", role: "service_role", ref: PROD_REF }))).toBe(PROD_REF);
  });

  it.each([
    ["not three segments", "abc.def"],
    ["an undecodable payload", "aaa.!!!!.sig"],
    ["a wrong issuer", jwt({ iss: "evil", role: "anon", ref: PROD_REF })],
    [
      "a role that is neither anon nor service_role",
      jwt({ iss: "supabase", role: "admin", ref: PROD_REF }),
    ],
    ["a missing ref", jwt({ iss: "supabase", role: "anon" })],
    ["a malformed ref", jwt({ iss: "supabase", role: "anon", ref: "SHOUTING" })],
    ["a payload that is not an object", `${b64url("{}")}.${b64url('"a string"')}.sig`],
  ])("throws on %s", (_label, key) => {
    expect(() => refOfJwt(key)).toThrow(UnknownEnvironment);
  });
});

describe("classify — unknown and mixed both fail closed", () => {
  it("classifies the known prod ref as prod", () => {
    expect(classify([{ ref: PROD_REF }])).toBe("prod");
  });

  it("classifies a local target as scratch", () => {
    expect(classify([{ local: true }])).toBe("scratch");
  });

  // 1D: classify() throws UnknownEnvironment on any ref outside an allowlist, so
  // the first CI run against the scratch DB failed closed until this ref landed.
  it("classifies the ez-scratch ref as scratch", () => {
    expect(classify([{ ref: SCRATCH_REF }])).toBe("scratch");
  });

  it("still refuses to mix the scratch ref with prod", () => {
    expect(() => classify([{ ref: SCRATCH_REF }, { ref: PROD_REF }])).toThrow(/mixed environments/);
  });

  it("throws on a well-formed ref that is in no allowlist", () => {
    expect(() => classify([{ ref: OTHER_REF }])).toThrow(/not in any allowlist/);
  });

  it("throws on mixed prod and scratch rather than picking one", () => {
    expect(() => classify([{ ref: PROD_REF }, { local: true }])).toThrow(/mixed environments/);
  });

  it("throws when there is nothing to classify", () => {
    expect(() => classify([])).toThrow(UnknownEnvironment);
  });
});

describe("resolveEnv — the whole gate", () => {
  const prodUrl = { SUPABASE_URL: `https://${PROD_REF}.supabase.co` } satisfies EnvSource;

  it("defaults EZ_PROCESS_KIND to agent when unset, so a forgotten variable fails safe", () => {
    const resolved = resolveEnv(prodUrl);
    expect(resolved.kind).toBe("agent");
    expect(resolved.isAgentProcess).toBe(true);
    expect(resolved.envClass).toBe("prod");
  });

  it.each(["app", "edge"])("lets a %s process opt out explicitly", (kind) => {
    expect(resolveEnv({ ...prodUrl, EZ_PROCESS_KIND: kind }).isAgentProcess).toBe(false);
  });

  it("throws on an unrecognised EZ_PROCESS_KIND", () => {
    expect(() => resolveEnv({ ...prodUrl, EZ_PROCESS_KIND: "root" })).toThrow(
      /EZ_PROCESS_KIND=root/,
    );
  });

  it("throws when no target is configured at all", () => {
    expect(() => resolveEnv({})).toThrow(/no Supabase target configured/);
  });

  it("throws when EZ_ENV_CLAIM disagrees with what the targets resolve to", () => {
    expect(() => resolveEnv({ ...prodUrl, EZ_ENV_CLAIM: "scratch" })).toThrow(
      /EZ_ENV_CLAIM=scratch but targets resolve to prod/,
    );
  });

  it("accepts EZ_ENV_CLAIM when it agrees", () => {
    expect(resolveEnv({ ...prodUrl, EZ_ENV_CLAIM: "prod" }).envClass).toBe("prod");
  });

  it("throws when a key's ref disagrees with the URL's ref", () => {
    expect(() =>
      resolveEnv({ SUPABASE_URL: "http://localhost:54321", SUPABASE_ANON_KEY: anonKey(PROD_REF) }),
    ).toThrow(/mixed environments/);
  });

  it("throws when the key is malformed, even though the URL alone would classify fine", () => {
    expect(() => resolveEnv({ ...prodUrl, SUPABASE_ANON_KEY: "sb_publishable_notajwt" })).toThrow(
      UnknownEnvironment,
    );
  });

  // The negative that matters, verbatim from the spec: a pooler URL is the one
  // shape where the hostname is generic and only the username betrays prod.
  it("classifies a bare pooler URL as prod with SUPABASE_URL unset", () => {
    const resolved = resolveEnv({
      SUPABASE_POOLER_URL: `postgres://postgres.${PROD_REF}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
    });
    expect(resolved.envClass).toBe("prod");
    expect(resolved.isAgentProcess).toBe(true); // → createDb trips the kill switch
  });
});
