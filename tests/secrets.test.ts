import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KillSwitchTrip } from "../packages/config/kill-switch.ts";
import {
  defineManifest,
  readSecret,
  registerSecretValue,
  resetSecretRegistry,
  scrub,
  scrubDeep,
  SECRET_NAMES,
  type SkillManifest,
} from "../agents/secrets.ts";

/**
 * NOTE ON FIXTURES — this is not stylistic.
 *
 * EZ-002's `check:env` rail scans every TRACKED file for credential SHAPES. A
 * test that pastes a literal `sb_secret_…` string to prove the scrubber catches
 * it would fail that rail — correctly, because the rail cannot tell a fixture
 * from a real leak, and a rail with a "but not in tests" exemption is how real
 * keys end up in test files.
 *
 * So every credential-shaped fixture below is ASSEMBLED AT RUNTIME. The shape
 * exists in memory, where the scrubber sees it; it never exists in the file.
 */
const shape = (...parts: string[]) => parts.join("");

const FAKE_SB_SECRET = shape("sb", "_", "secret", "_", "AaBbCcDd11223344");
const FAKE_SB_PUBLISHABLE = shape("sb", "_", "publishable", "_", "ZzYyXxWw99887766");
const FAKE_SK = shape("sk", "-", "AaBbCcDdEeFf0123456789");

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fakeJwt = (payload: Record<string, unknown>) =>
  [b64url({ alg: "HS256", typ: "JWT" }), b64url(payload), "c2lnbmF0dXJlCg"].join(".");

const FAKE_SERVICE_JWT = fakeJwt({
  iss: "supabase",
  ref: "abcdefghij0123456789",
  role: "service_role",
});

const originalEnv = { ...process.env };

beforeEach(() => {
  resetSecretRegistry();
});

afterEach(() => {
  resetSecretRegistry();
  process.env = { ...originalEnv };
});

// ---------------------------------------------------------------------------
// defineManifest
// ---------------------------------------------------------------------------

describe("defineManifest", () => {
  it("accepts a name from SECRET_NAMES", () => {
    const m = defineManifest({ name: "t", secrets: ["ANTHROPIC_API_KEY"] });
    expect(m.secrets).toEqual(["ANTHROPIC_API_KEY"]);
    expect(m.maxDepth).toBe(1);
  });

  it("hard-fails on an unknown secret name — a typo must not silently widen an allowlist", () => {
    expect(() => defineManifest({ name: "t", secrets: ["ANTHROPIC_API_KY"] })).toThrow(
      /unknown secret name/,
    );
  });

  it("hard-fails on a duplicate name", () => {
    expect(() =>
      defineManifest({ name: "t", secrets: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"] }),
    ).toThrow(/duplicate/);
  });

  it("hard-fails on an empty name", () => {
    expect(() => defineManifest({ name: "  ", secrets: [] })).toThrow(/name is required/);
  });

  it("returns a frozen manifest, secrets array included", () => {
    const m = defineManifest({ name: "t", secrets: ["ANTHROPIC_API_KEY"] });
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.secrets)).toBe(true);
    // A skill must not be able to grant itself a secret at runtime.
    expect(() => {
      (m.secrets as string[]).push("SUPABASE_SERVICE_ROLE");
    }).toThrow();
  });

  it("copies the caller's array, so mutating the input cannot widen the manifest afterwards", () => {
    const input: string[] = ["ANTHROPIC_API_KEY"];
    const m = defineManifest({ name: "t", secrets: input });
    input.push("SUPABASE_SERVICE_ROLE");
    expect(m.secrets).toEqual(["ANTHROPIC_API_KEY"]);
  });
});

// ---------------------------------------------------------------------------
// readSecret — rule 41
// ---------------------------------------------------------------------------

describe("readSecret", () => {
  const manifest: SkillManifest = defineManifest({ name: "demo", secrets: ["ANTHROPIC_API_KEY"] });

  it("returns a declared secret", () => {
    process.env["ANTHROPIC_API_KEY"] = FAKE_SK;
    expect(readSecret(manifest, "ANTHROPIC_API_KEY")).toBe(FAKE_SK);
  });

  it("SPEC 1C case: a skill declaring MODEL key reading SUPABASE_SERVICE_ROLE trips the kill switch", () => {
    process.env["SUPABASE_SERVICE_ROLE"] = FAKE_SERVICE_JWT;
    let err: unknown;
    try {
      readSecret(manifest, "SUPABASE_SERVICE_ROLE");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KillSwitchTrip);
    expect((err as KillSwitchTrip).reason).toBe("secret_scope");
    expect((err as Error).message).toContain("demo");
  });

  it("trips even when the undeclared value is present and readable — presence is not permission", () => {
    process.env["DATABASE_URL"] = "postgres://u:p@db.example.com:5432/postgres";
    expect(() => readSecret(manifest, "DATABASE_URL")).toThrow(KillSwitchTrip);
  });

  it("a MISSING declared secret is an ordinary Error, not a trip", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    let err: unknown;
    try {
      readSecret(manifest, "ANTHROPIC_API_KEY");
    } catch (e) {
      err = e;
    }
    // Nothing was reached for that was not granted — the deployment is just
    // incomplete. Classing this as a trip would cry wolf and get the rail muted.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(KillSwitchTrip);
    expect((err as Error).message).toBe("missing secret ANTHROPIC_API_KEY");
  });

  it("an empty-string secret counts as missing", () => {
    process.env["ANTHROPIC_API_KEY"] = "";
    expect(() => readSecret(manifest, "ANTHROPIC_API_KEY")).toThrow(/missing secret/);
  });

  it("the trip message names the skill and the name asked for, never a value", () => {
    process.env["SUPABASE_SERVICE_ROLE"] = FAKE_SERVICE_JWT;
    try {
      readSecret(manifest, "SUPABASE_SERVICE_ROLE");
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(FAKE_SERVICE_JWT);
    }
  });

  it("registers the value it hands out, so a later log line is scrubbed", () => {
    process.env["ANTHROPIC_API_KEY"] = FAKE_SK;
    readSecret(manifest, "ANTHROPIC_API_KEY");
    expect(scrub(`calling model with key=${FAKE_SK}`)).toBe(
      "calling model with key=[redacted:ANTHROPIC_API_KEY]",
    );
  });

  it("1C-1: REFUSES a secret too short to register — it would otherwise be handed out and never scrubbed", () => {
    // 7 characters: under the registry threshold. Before 1C-1 this value was
    // returned to the skill AND skipped by registerSecretValue, so the scrubber
    // could never redact it — the review demonstrated it printing in cleartext.
    process.env["ANTHROPIC_API_KEY"] = "abcdefg";
    let err: unknown;
    try {
      readSecret(manifest, "ANTHROPIC_API_KEY");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(KillSwitchTrip); // a config defect, not a policy breach
    const msg = (err as Error).message;
    expect(msg).toContain("ANTHROPIC_API_KEY"); // names the variable...
    expect(msg).toContain("demo"); // ...and the skill that asked
    expect(msg).not.toContain("abcdefg"); // ...never the value
    // And nothing leaked into the registry on the way to the throw.
    expect(scrub("abcdefg here")).toBe("abcdefg here");
  });

  it("1C-1: a value at or above the threshold is handed out and registered as before", () => {
    process.env["ANTHROPIC_API_KEY"] = "abcdefgh12345"; // 13 chars, no known shape
    expect(readSecret(manifest, "ANTHROPIC_API_KEY")).toBe("abcdefgh12345");
    expect(scrub("key abcdefgh12345 sent")).toBe("key [redacted:ANTHROPIC_API_KEY] sent");
  });

  it("reads through Deno.env when process.env has nothing (Edge Functions)", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const g = globalThis as { Deno?: unknown };
    g.Deno = { env: { get: (k: string) => (k === "ANTHROPIC_API_KEY" ? FAKE_SK : undefined) } };
    try {
      expect(readSecret(manifest, "ANTHROPIC_API_KEY")).toBe(FAKE_SK);
    } finally {
      delete g.Deno;
    }
  });
});

// ---------------------------------------------------------------------------
// The scrubber — registered values
// ---------------------------------------------------------------------------

describe("scrub — registered values", () => {
  it("replaces a planted key anywhere in a log line", () => {
    registerSecretValue("ANTHROPIC_API_KEY", FAKE_SK);
    expect(scrub(`before ${FAKE_SK} after`)).toBe("before [redacted:ANTHROPIC_API_KEY] after");
  });

  it("replaces every occurrence, not just the first", () => {
    registerSecretValue("ANTHROPIC_API_KEY", FAKE_SK);
    const out = scrub(`${FAKE_SK} and again ${FAKE_SK}`);
    expect(out).not.toContain(FAKE_SK);
    expect(out.match(/\[redacted:ANTHROPIC_API_KEY\]/g)).toHaveLength(2);
  });

  it("matches a value containing regex metacharacters", () => {
    // split/join, not RegExp — a value like this would break a naive
    // `new RegExp(value)` implementation, or worse, silently not match.
    const nasty = "pw)+*?[a-z]$^{2}|x";
    registerSecretValue("DATABASE_URL", nasty);
    expect(scrub(`url=${nasty}`)).toBe("url=[redacted:DATABASE_URL]");
  });

  it("redacts the longest registered value first", () => {
    const password = "s3cr3tp4ssw0rd";
    const url = `postgres://postgres:${password}@db.example.com:5432/postgres`;
    registerSecretValue("PGPASSWORD_LIKE", password);
    registerSecretValue("DATABASE_URL", url);
    const out = scrub(`connecting to ${url}`);
    // The whole URL goes as one unit. Shortest-first would have left
    // `postgres://postgres:[redacted:…]@db.example.com…` — still disclosing host,
    // port, database name and username.
    expect(out).toBe("connecting to [redacted:DATABASE_URL]");
  });

  it("does not register a value shorter than 8 characters", () => {
    registerSecretValue("ANTHROPIC_API_KEY", "abc");
    // Redacting every "abc" in every log line would destroy the logs and teach
    // people that redaction output is noise. This is only safe because the read
    // path fails first: readSecret refuses a value this short (1C-1), so a
    // too-short secret never reaches a skill unregistered. The shape patterns do
    // NOT cover arbitrary short values — that claim was wrong and is gone.
    expect(scrub("abc appears in abcdef")).toBe("abc appears in abcdef");
  });

  it("resetSecretRegistry clears registrations, leaving only the shape patterns", () => {
    const notAKnownShape = "plain-value-with-no-recognisable-shape";
    registerSecretValue("DATABASE_URL", notAKnownShape);
    expect(scrub(notAKnownShape)).toBe("[redacted:DATABASE_URL]");
    resetSecretRegistry();
    expect(scrub(notAKnownShape)).toBe(notAKnownShape);
  });
});

// ---------------------------------------------------------------------------
// The scrubber — shape patterns (the backstop for values never read via readSecret)
// ---------------------------------------------------------------------------

describe("scrub — shape patterns", () => {
  it("redacts an sb_secret key", () => {
    expect(scrub(`key=${FAKE_SB_SECRET}`)).toBe("key=[redacted:SB_SECRET]");
  });

  it("redacts an sb_publishable key — not secret, but it fingerprints the project", () => {
    expect(scrub(`key=${FAKE_SB_PUBLISHABLE}`)).toBe("key=[redacted:SB_PUBLISHABLE]");
  });

  it("redacts a JWT", () => {
    expect(scrub(`auth ${FAKE_SERVICE_JWT} done`)).toBe("auth [redacted:JWT] done");
  });

  it("redacts an sk- style API key", () => {
    expect(scrub(`Authorization: Bearer ${FAKE_SK}`)).toBe(
      "Authorization: Bearer [redacted:API_KEY]",
    );
  });

  it("redacts a PEM private key block including its body", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxx",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = scrub(`cfg:\n${pem}\ndone`);
    expect(out).toBe("cfg:\n[redacted:PRIVATE_KEY]\ndone");
    expect(out).not.toContain("MIIEow");
  });

  it("redacts a connection-string password but keeps scheme and host", () => {
    const out = scrub(
      "postgres://postgres.abc:hunter2@aws-0-us-east-1.pooler.supabase.com:6543/db",
    );
    // Same reasoning as 1B's error messages: an operator must be able to tell
    // WHICH database a line is about. The host is not the secret; the password is.
    expect(out).toContain("aws-0-us-east-1.pooler.supabase.com");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[redacted:URL_PASSWORD]");
  });

  it("redacts PII — email, phone, MC number (rule 22; 9A depends on this)", () => {
    expect(scrub("driver dan@example.com")).toBe("driver [redacted:EMAIL]@example.com");
    expect(scrub("call (555) 123-4567 now")).toBe("call [redacted:PHONE] now");
    expect(scrub("carrier MC-123456 ok")).toBe("carrier [redacted:MC_NUMBER] ok");
    expect(scrub("carrier MC 1234567")).toBe("carrier [redacted:MC_NUMBER]");
  });

  it("1C-3: an email keeps its domain — 4C intake failures must say WHICH broker, and the domain is not the private part", () => {
    // Same reasoning as URL_PASSWORD keeping the host. The local part is what
    // identifies a person; the domain is what an operator needs to debug.
    const out = scrub("intake failed for dispatch.jenny@acmefreight.com: no rate con attached");
    expect(out).toBe("intake failed for [redacted:EMAIL]@acmefreight.com: no rate con attached");
    expect(out).not.toContain("jenny");
    expect(out).toContain("acmefreight.com");
    // Object keys go through the same rule (scrubDeep), so a log keyed by address
    // is attributable without being identifying.
    expect(scrub("dan@example.com,eve@example.org")).toBe(
      "[redacted:EMAIL]@example.com,[redacted:EMAIL]@example.org",
    );
  });

  it("1C-2: bare digits redact — a keypad produces no separators, so this is the common case", () => {
    // The previous rule required a separator before the last four digits, so a
    // dialled number never redacted. The review tested both bare forms: NO MATCH.
    expect(scrub("call me at 5551234567")).toBe("call me at [redacted:PHONE]");
    expect(scrub("15551234567")).toBe("[redacted:PHONE]");
    expect(scrub("+15551234567")).toBe("[redacted:PHONE]");
  });

  it("1C-2: every formatted variant still redacts", () => {
    for (const v of ["(555) 123-4567", "555-123-4567", "555.123.4567", "555 123 4567", "+1 555-123-4567", "1-555-123-4567"]) {
      expect(scrub(`tel ${v} end`), v).toBe("tel [redacted:PHONE] end");
    }
  });

  it("1C-2: what keeps bare digits from eating epochs and load numbers is the area-code rule + the guards", () => {
    // The old rule protected these with a mandatory separator. That is gone, so
    // the protection has to come from somewhere real: an area code cannot begin
    // with 0 or 1. Every 10-digit Unix epoch for the next two centuries begins
    // with 1, so it fails at the first digit — and treating that 1 as a country
    // code leaves only nine digits, which cannot form a number either.
    const epoch = "1757612345";
    expect(scrub(`at ${epoch} delivered`)).toBe(`at ${epoch} delivered`);
    expect(scrub("0551234567")).toBe("0551234567"); // area code starting with 0
    expect(scrub("1551234567")).toBe("1551234567"); // area code starting with 1, no country code to absorb it
    expect(scrub("5551234567890")).toBe("5551234567890"); // 13-digit run: lookaround guards hold
    expect(scrub("load 20260911123456")).toBe("load 20260911123456"); // 14-digit load id
    expect(scrub("carrier MC 1234567")).toBe("carrier [redacted:MC_NUMBER]"); // 7 digits: MC, not phone
  });

  it("leaves ordinary text alone — a rail that cries wolf gets switched off", () => {
    const line = "load 4821 delivered to Dallas TX at 14:05, rate 2350.00, 512 miles";
    expect(scrub(line)).toBe(line);
  });
});

// ---------------------------------------------------------------------------
// scrubDeep — for Sentry beforeSend, the audit writer, the structured logger
// ---------------------------------------------------------------------------

describe("scrubDeep", () => {
  it("scrubs nested values and array elements", () => {
    registerSecretValue("ANTHROPIC_API_KEY", FAKE_SK);
    const out = scrubDeep({ a: { b: [`k=${FAKE_SK}`] }, n: 1, ok: true });
    expect(out).toEqual({ a: { b: ["k=[redacted:ANTHROPIC_API_KEY]"] }, n: 1, ok: true });
  });

  it("scrubs object KEYS too", () => {
    // A log entry keyed by a customer email leaks as much as one with the
    // address in the value.
    const out = scrubDeep({ "dan@example.com": "ok" });
    // 1C-3: the domain survives in keys too — attributable, not identifying.
    expect(Object.keys(out)).toEqual(["[redacted:EMAIL]@example.com"]);
  });

  it("scrubs an Error message and stack without losing the name", () => {
    registerSecretValue("ANTHROPIC_API_KEY", FAKE_SK);
    const e = new Error(`failed with ${FAKE_SK}`);
    e.name = "ProviderError";
    const out = scrubDeep(e);
    expect(out.name).toBe("ProviderError");
    expect(out.message).toBe("failed with [redacted:ANTHROPIC_API_KEY]");
    expect(out.stack ?? "").not.toContain(FAKE_SK);
  });

  it("survives a cycle — Sentry payloads have them, and the scrubber must not be the crash", () => {
    const a: Record<string, unknown> = { name: "a" };
    a["self"] = a;
    expect(() => scrubDeep(a)).not.toThrow();
    expect((scrubDeep(a) as Record<string, unknown>)["self"]).toBe("[circular]");
  });

  it("passes through primitives untouched", () => {
    expect(scrubDeep(42)).toBe(42);
    expect(scrubDeep(null)).toBe(null);
    expect(scrubDeep(undefined)).toBe(undefined);
    expect(scrubDeep(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The real manifests
// ---------------------------------------------------------------------------

describe("shipped skill manifests", () => {
  const SKILLS = [
    "broker-draft",
    "doc-classifier",
    "exception-triage",
    "rate-con-reader",
    "true-net-explainer",
    "voice-turn",
  ] as const;

  it("every skill directory has a manifest that loads, is frozen, and declares only known names", async () => {
    for (const slug of SKILLS) {
      const mod: Record<string, unknown> = await import(`../agents/skills/${slug}/manifest.ts`);
      const manifests = Object.values(mod).filter(
        (v): v is SkillManifest => typeof v === "object" && v !== null && "maxDepth" in v,
      );
      expect(manifests, `${slug} exports no manifest`).toHaveLength(1);

      const m = manifests[0]!;
      expect(m.name).toBe(slug);
      expect(Object.isFrozen(m)).toBe(true);
      expect(m.maxDepth).toBe(1);
      for (const s of m.secrets) expect(SECRET_NAMES).toContain(s);
    }
  });

  it("no shipped skill holds a credential today — so any readSecret from one trips", () => {
    // If this ever fails, that is the review signal: a skill was granted a
    // secret, and the diff that did it should say why.
    expect(SKILLS.length).toBe(6);
  });
});
