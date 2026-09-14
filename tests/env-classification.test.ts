import { describe, expect, it } from "vitest";

import {
  UnknownEnvironment,
  classify,
  refOf,
  refOfJwt,
  resolveEnv,
  type EnvSource,
  mergeEnvSources,
  readEnvSource,
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
    // Assembled at runtime so no tracked file holds a literal user:password@host —
    // .gitleaks.toml's connection-string rule would (correctly) flag it otherwise.
    const withPassword = ["postgres://postgres:", "hunter2", "@db.eztrucking.com:5432/postgres"].join("");
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

// ---------------------------------------------------------------------------
// P-1B-2 (panel pass, 2026-09-11): the browser has no `process`
//
// Why these tests feed `mergeEnvSources` directly instead of deleting `process`:
// under vitest `import.meta.env` is a proxy over `process.env` — the very first
// attempt at this test proved it (delete process → "no Supabase target
// configured", because env.ts's import.meta.env emptied with it). The two are
// the same object in the runner, so the browser cannot be simulated there. A
// meta object plus `undefined` for process IS the browser, with nothing faked.
// ---------------------------------------------------------------------------

describe("mergeEnvSources / getEnv — the browser bundle, where process is undefined", () => {
  it("classifies from import.meta.env alone (no process at all) with EZ_PROCESS_KIND=app", () => {
    const browser = mergeEnvSources(
      { SUPABASE_URL: `https://${SCRATCH_REF}.supabase.co`, EZ_PROCESS_KIND: "app" },
      undefined,
    );
    const resolved = resolveEnv(browser);
    expect(resolved.envClass).toBe("scratch");
    expect(resolved.kind).toBe("app");
    expect(resolved.isAgentProcess).toBe(false);
  });

  it("still fails safe in the browser when EZ_PROCESS_KIND is not inlined — kind defaults to agent", () => {
    const browser = mergeEnvSources({ SUPABASE_URL: `https://${SCRATCH_REF}.supabase.co` }, undefined);
    expect(resolveEnv(browser).isAgentProcess).toBe(true);
  });

  it("a runtime process.env value supersedes a build-time import.meta.env value", () => {
    const merged = mergeEnvSources({ EZ_ENV_CLAIM: "scratch" }, { EZ_ENV_CLAIM: "prod" });
    expect(merged["EZ_ENV_CLAIM"]).toBe("prod");
  });

  it("tolerates a missing or non-object import.meta.env (plain Node/Bun, no Vite) and a missing process", () => {
    expect(mergeEnvSources(undefined, undefined)).toEqual({});
    expect(mergeEnvSources(null, { A: "1" })["A"]).toBe("1");
    expect(mergeEnvSources("not-an-object", { A: "1" })["A"]).toBe("1");
    expect(mergeEnvSources({ A: "meta" }, 42)["A"]).toBe("meta");
  });

  it("readEnvSource() carries live process.env values into the merged view", () => {
    process.env["EZ_PROCESS_KIND"] = "edge";
    try {
      expect(readEnvSource()["EZ_PROCESS_KIND"]).toBe("edge");
    } finally {
      delete process.env["EZ_PROCESS_KIND"];
    }
  });
});

/**
 * TICKET 1F item 3 — finding H-4: every accepted credential name is validated.
 *
 * The state 1B accepted, which these cases now refuse: `db.ts` kept its own
 * `USER_KEY_NAMES` including the publishable names, while `env.ts` kept a
 * JWT-only `KEY_VARS`. A name the factory accepted and the classifier had never
 * heard of is a name no agreement check ever ran on — so 1B's strongest check
 * did not execute for the key format the front end actually ships.
 */
describe("1F/H-4 — one canonical credential set, checked by shape and by capability", () => {
  const serviceKey = (ref: string) => jwt({ iss: "supabase", role: "service_role", ref });
  // Split so the literal never appears whole in this file — the secret rail
  // scans tracked source, and a realistic key shape in a fixture is what it is
  // built to stop. Same treatment tests/db-boundary.test.ts already uses.
  const publishable = ["sb_", "publishable_", "AaBbCcDd11223344"].join("");
  const sbSecret = ["sb_", "secret_", "AaBbCcDd11223344"].join("");

  const scratchUrl = { SUPABASE_URL: `https://${SCRATCH_REF}.supabase.co` };
  /** No proven kind, so these cases exercise the classifier and not process identity. */
  const resolve = (source: EnvSource) => resolveEnv({ EZ_PROCESS_KIND: "edge", ...source }, undefined);

  describe("the bad state H-4 named, in the direction that is actually detectable", () => {
    it("refuses a PROD anon JWT sitting under a publishable name with a SCRATCH url", () => {
      // This is H-4's headline case. Before 1F the publishable names were unknown
      // to the classifier, so this config resolved to "scratch" on the strength of
      // the URL alone and the prod key went entirely unexamined.
      expect(() =>
        resolve({ ...scratchUrl, VITE_SUPABASE_PUBLISHABLE_KEY: anonKey(PROD_REF) }),
      ).toThrow(UnknownEnvironment);
      expect(() =>
        resolve({ ...scratchUrl, VITE_SUPABASE_PUBLISHABLE_KEY: anonKey(PROD_REF) }),
      ).toThrow(/mixed environments/);
    });

    it("accepts the same legacy JWT when it agrees with the url", () => {
      // Proving the case above measures DISAGREEMENT and not merely "a JWT here
      // is banned". A project issued before the new key format ships a legacy
      // anon JWT under exactly this name; refusing it outright would break a
      // working deployment to buy nothing.
      expect(
        resolve({ ...scratchUrl, VITE_SUPABASE_PUBLISHABLE_KEY: anonKey(SCRATCH_REF) }).envClass,
      ).toBe("scratch");
    });
  });

  describe("shape must match the name", () => {
    it("refuses an sb_publishable value in a JWT-named variable (SPEC 1B v3.1)", () => {
      expect(() => resolve({ ...scratchUrl, SUPABASE_ANON_KEY: publishable })).toThrow(
        /SUPABASE_ANON_KEY holds a sb_publishable value/,
      );
    });

    it("refuses an sb_secret value in a JWT-named variable", () => {
      expect(() => resolve({ ...scratchUrl, SCRATCH_SERVICE_ROLE: sbSecret })).toThrow(
        /SCRATCH_SERVICE_ROLE holds a sb_secret value/,
      );
    });

    it("refuses a value of no recognised format at all", () => {
      expect(() => resolve({ ...scratchUrl, SUPABASE_ANON_KEY: "not-a-key" })).toThrow(
        /not a recognised key format/,
      );
    });
  });

  describe("capability — a name is a claim, a value is a fact", () => {
    it("refuses a service-role JWT under an anon name", () => {
      // The dangerous direction: an RLS-bypassing key under a VITE_ name is
      // inlined into the browser bundle by Vite and published to every visitor.
      expect(() =>
        resolve({ ...scratchUrl, VITE_SUPABASE_ANON_KEY: serviceKey(SCRATCH_REF) }),
      ).toThrow(/anon credential name but holds a value with privileged capability/);
    });

    it("refuses an anon JWT under a service-role name", () => {
      // The quieter direction, and the one our own fixtures got wrong before H-4:
      // a read whose whole purpose is establishing privileged access must never
      // be satisfied by something that cannot bypass RLS.
      expect(() => resolve({ ...scratchUrl, SCRATCH_SERVICE_ROLE: anonKey(SCRATCH_REF) })).toThrow(
        /privileged credential name but holds a value with anon capability/,
      );
    });

    it("accepts a service-role JWT under a service-role name", () => {
      expect(resolve({ ...scratchUrl, SCRATCH_SERVICE_ROLE: serviceKey(SCRATCH_REF) }).envClass).toBe(
        "scratch",
      );
    });
  });

  describe("the opaque formats, and the limit that is not fixable in code", () => {
    it("classifies the app's real shipping config from the url alone", () => {
      expect(
        resolve({ ...scratchUrl, VITE_SUPABASE_PUBLISHABLE_KEY: publishable }).envClass,
      ).toBe("scratch");
    });

    it("contributes NO ref, so the url is provably the sole authority", async () => {
      const { credentialRefs, OPAQUE_KEY_FORMATS, detectKeyFormat } = await import(
        "../packages/config/env.ts"
      );
      // Asserted rather than left in prose: an sb_* key carries no project
      // identifier of any kind, so the "URL=scratch + publishable key=prod" case
      // is NOT detectable here or anywhere else. Stated in the source too; if a
      // later change makes these keys ref-bearing, this test is what tells you
      // the comment needs rewriting.
      expect(credentialRefs({ VITE_SUPABASE_PUBLISHABLE_KEY: publishable })).toEqual([]);
      expect(OPAQUE_KEY_FORMATS).toContain(detectKeyFormat(publishable));
      expect(OPAQUE_KEY_FORMATS).toContain(detectKeyFormat(sbSecret));
      // And a JWT is not opaque — it is the half we CAN cross-check.
      expect(credentialRefs({ SUPABASE_ANON_KEY: anonKey(SCRATCH_REF) })).toEqual([SCRATCH_REF]);
    });
  });

  describe("the two lists are now one", () => {
    it("db.ts's accepted names are derived from the table, by capability", async () => {
      const { USER_KEY_NAMES, SERVICE_KEY_NAMES, CREDENTIAL_VAR_NAMES } = await import(
        "../packages/config/env.ts"
      );
      // The publishable names are the ones that used to be in db.ts and not here.
      expect(USER_KEY_NAMES).toContain("VITE_SUPABASE_PUBLISHABLE_KEY");
      expect(USER_KEY_NAMES).toContain("SUPABASE_PUBLISHABLE_KEY");
      // No name is both, and together they are the whole table — so a name added
      // to the table can never be silently unreachable from the factory.
      expect(USER_KEY_NAMES.filter((n) => SERVICE_KEY_NAMES.includes(n))).toEqual([]);
      expect([...USER_KEY_NAMES, ...SERVICE_KEY_NAMES].sort()).toEqual(
        [...CREDENTIAL_VAR_NAMES].sort(),
      );
    });

    it("a name outside the table is refused rather than ignored", async () => {
      const { validateCredential } = await import("../packages/config/env.ts");
      expect(() => validateCredential("SUPABASE_SOMETHING_ELSE", anonKey(SCRATCH_REF))).toThrow(
        /not an accepted credential name/,
      );
    });
  });

  it("rule 6: no rejection message ever contains the credential value", () => {
    const cases: Array<[string, string]> = [
      ["SUPABASE_ANON_KEY", publishable],
      ["SCRATCH_SERVICE_ROLE", sbSecret],
      ["VITE_SUPABASE_ANON_KEY", serviceKey(SCRATCH_REF)],
      ["SCRATCH_SERVICE_ROLE", anonKey(SCRATCH_REF)],
      ["SUPABASE_ANON_KEY", "not-a-key"],
    ];
    for (const [name, value] of cases) {
      let message = "";
      try {
        resolve({ ...scratchUrl, [name]: value });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(value);
    }
  });
});
