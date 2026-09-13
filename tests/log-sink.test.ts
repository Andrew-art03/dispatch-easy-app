/**
 * TICKET 1F item 5 — findings H-6 and H-7: scrub at the SINK, not the object.
 *
 * Every case here is written so it would FAIL against 1C's rails alone. Where
 * that is the whole point of the case, the old behaviour is asserted alongside
 * the new one — a regression test that cannot distinguish the fix from the bug
 * is decoration.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  createScrubbedSink,
  formatAndScrub,
  installScrubbedConsole,
  renderArg,
} from "../agents/log-sink.ts";
import {
  registerSecretValue,
  resetSecretRegistry,
  safeSplitIndex,
  scrub,
  scrubDeep,
} from "../agents/secrets.ts";

/**
 * Fixture credentials, assembled from parts so no realistic-looking secret sits
 * whole in tracked source — `check:env` scans this file and is right to.
 * Deliberately NOT matching any shape in PATTERNS: these cases have to prove the
 * REGISTRY rail works at the sink, and a value the pattern rail would catch
 * anyway proves nothing.
 */
const TOKEN = ["ez", "-fixture-", "AaBbCcDd11223344", "-not-a-real-credential"].join("");
const PUNCTUATED = ["ez-fixture", "/slash+plus=equals", "?query&amp"].join("");
const QUOTED = ['ez-fixture "quoted"', " and \\ backslash"].join("");

afterEach(() => {
  resetSecretRegistry();
});

describe("1F/H-6 — the scrub happens after formatting, not before", () => {
  it("catches a secret the caller never ran through scrubDeep at all", () => {
    registerSecretValue("ANTHROPIC_API_KEY", TOKEN);
    // This is the shape of the finding. scrubDeep is correct and it is also a
    // function somebody has to remember to call; the sink is a place output
    // goes through whether anyone remembered or not.
    expect(formatAndScrub({ authorization: `Bearer ${TOKEN}` })).not.toContain(TOKEN);
    expect(formatAndScrub({ authorization: `Bearer ${TOKEN}` })).toContain(
      "[redacted:ANTHROPIC_API_KEY]",
    );
  });

  it("scrubs AFTER joining the arguments, not each argument separately", () => {
    registerSecretValue("ANTHROPIC_API_KEY", TOKEN);
    const out = formatAndScrub("Bearer", TOKEN, "sent");
    expect(out).not.toContain(TOKEN);
    expect(out).toBe("Bearer [redacted:ANTHROPIC_API_KEY] sent");
  });

  it("redacts a Buffer, which scrubDeep mangles into bytes instead", () => {
    registerSecretValue("ANTHROPIC_API_KEY", TOKEN);
    const buf = new TextEncoder().encode(TOKEN);

    // The old rail on the same input: a Uint8Array is an object, so scrubDeep
    // walks it as one and produces a numeric map. Nothing is redacted because
    // nothing it visited was ever a string.
    const walked = scrubDeep(buf) as unknown as Record<string, unknown>;
    expect(typeof walked).toBe("object");
    expect(Object.keys(walked).length).toBeGreaterThan(0);

    // The sink decodes first, so what gets printed is what gets scrubbed.
    expect(renderArg(buf)).toBe(TOKEN);
    expect(formatAndScrub(buf)).toBe("[redacted:ANTHROPIC_API_KEY]");
  });

  it("redacts a secret inside an Error's stack", () => {
    registerSecretValue("DATABASE_URL", PUNCTUATED);
    const out = formatAndScrub(new Error(`connect failed for ${PUNCTUATED}`));
    expect(out).not.toContain(PUNCTUATED);
    expect(out).toContain("[redacted:DATABASE_URL]");
  });

  it("redacts the URL-ENCODED form of a registered secret", () => {
    registerSecretValue("DATABASE_URL", PUNCTUATED);
    const encoded = encodeURIComponent(PUNCTUATED);
    // Guard: if this ever stops differing, the case is no longer testing
    // anything and the assertion below would pass for the wrong reason.
    expect(encoded).not.toBe(PUNCTUATED);
    expect(formatAndScrub(`GET /x?dsn=${encoded}`)).not.toContain(encoded);
  });

  it("redacts the JSON-ESCAPED form of a registered secret", () => {
    registerSecretValue("DATABASE_URL", QUOTED);
    const escaped = JSON.stringify(QUOTED).slice(1, -1);
    expect(escaped).not.toBe(QUOTED);
    expect(formatAndScrub(`body=${escaped}`)).not.toContain(escaped);
  });

  it("never throws on input it cannot render — a logger that dies loses the incident", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => formatAndScrub(cyclic)).not.toThrow();
    expect(() => formatAndScrub(undefined, null, 1, true, Symbol("s"))).not.toThrow();
  });
});

describe("1F/H-6 — console is a boundary, not a convention", () => {
  it("routes every console method through the scrub and restores cleanly", () => {
    registerSecretValue("ANTHROPIC_API_KEY", TOKEN);
    const seen: string[] = [];
    const fake = {
      log: (...a: unknown[]) => seen.push(`log:${a.join(" ")}`),
      info: (...a: unknown[]) => seen.push(`info:${a.join(" ")}`),
      warn: (...a: unknown[]) => seen.push(`warn:${a.join(" ")}`),
      error: (...a: unknown[]) => seen.push(`error:${a.join(" ")}`),
      debug: (...a: unknown[]) => seen.push(`debug:${a.join(" ")}`),
    } as unknown as Console;

    const restore = installScrubbedConsole(fake);
    fake.log("a", TOKEN);
    fake.info(TOKEN);
    fake.warn(TOKEN);
    fake.error(new Error(TOKEN));
    fake.debug({ k: TOKEN });
    restore();
    fake.log("after restore", TOKEN);

    expect(seen).toHaveLength(6);
    for (const line of seen.slice(0, 5)) expect(line).not.toContain(TOKEN);
    // The last one proves restore() really put the original back, so the five
    // above are measuring the wrapper and not a coincidence.
    expect(seen[5]).toContain(TOKEN);
  });

  it("installing twice does not nest, and the first restore still works", () => {
    registerSecretValue("ANTHROPIC_API_KEY", TOKEN);
    const seen: string[] = [];
    const fake = { log: (...a: unknown[]) => seen.push(a.join(" ")) } as unknown as Console;

    const restore = installScrubbedConsole(fake);
    const second = installScrubbedConsole(fake); // no-op
    second();
    fake.log(TOKEN);
    expect(seen[0]).not.toContain(TOKEN);

    restore();
    fake.log(TOKEN);
    // Without the guard, the second install would have captured the WRAPPER as
    // its "original" and restore() would never reach the real method again.
    expect(seen[1]).toContain(TOKEN);
  });
});

describe("1F/H-7 — a secret split across writes", () => {
  it("the naive per-write scrub leaks it, which is why the sink exists", () => {
    registerSecretValue("ANTHROPIC_API_KEY", TOKEN);
    const head = TOKEN.slice(0, 4);
    const tail = TOKEN.slice(4);
    // Neither fragment is a registered value, so each scrub is a no-op and the
    // stream carries the whole credential. This is the bug, asserted.
    expect(scrub(head) + scrub(tail)).toContain(TOKEN);
  });

  it("the sink does not, because it scrubs the reassembled line", () => {
    registerSecretValue("ANTHROPIC_API_KEY", TOKEN);
    const out: string[] = [];
    const sink = createScrubbedSink((t) => out.push(t));

    sink.write(TOKEN.slice(0, 4));
    sink.write(TOKEN.slice(4));
    sink.write("\n");

    expect(out.join("")).not.toContain(TOKEN);
    expect(out.join("")).toBe("[redacted:ANTHROPIC_API_KEY]\n");
  });

  it("emits nothing until a line is complete", () => {
    registerSecretValue("ANTHROPIC_API_KEY", TOKEN);
    const out: string[] = [];
    const sink = createScrubbedSink((t) => out.push(t));

    sink.write(TOKEN.slice(0, 4));
    expect(out).toEqual([]); // holding — this is the whole mechanism
    sink.write(TOKEN.slice(4));
    expect(out).toEqual([]);
    sink.flush();
    expect(out.join("")).toBe("[redacted:ANTHROPIC_API_KEY]");
  });

  it("splits many secrets across many chunks, one byte at a time", () => {
    registerSecretValue("ANTHROPIC_API_KEY", TOKEN);
    const out: string[] = [];
    const sink = createScrubbedSink((t) => out.push(t));

    const payload = `start ${TOKEN} middle ${TOKEN} end\n`;
    for (const ch of payload) sink.write(ch);
    sink.flush();

    const joined = out.join("");
    expect(joined).not.toContain(TOKEN);
    expect(joined).toBe(
      "start [redacted:ANTHROPIC_API_KEY] middle [redacted:ANTHROPIC_API_KEY] end\n",
    );
  });

  it("accepts Uint8Array chunks, the form a child process actually writes", () => {
    registerSecretValue("ANTHROPIC_API_KEY", TOKEN);
    const out: string[] = [];
    const sink = createScrubbedSink((t) => out.push(t));
    const bytes = new TextEncoder().encode(`${TOKEN}\n`);

    sink.write(bytes.slice(0, 3));
    sink.write(bytes.slice(3));

    expect(out.join("")).toBe("[redacted:ANTHROPIC_API_KEY]\n");
  });

  it("preserves line structure for anything downstream that cares", () => {
    const out: string[] = [];
    const sink = createScrubbedSink((t) => out.push(t));
    sink.write("one\ntwo\nthree");
    expect(out).toEqual(["one\n", "two\n"]);
    sink.flush();
    expect(out).toEqual(["one\n", "two\n", "three"]);
  });

  it("still redacts across the cap boundary when a stream never sends a newline", () => {
    registerSecretValue("ANTHROPIC_API_KEY", TOKEN);
    const out: string[] = [];
    // A cap small enough to force the no-newline path within this test.
    const sink = createScrubbedSink((t) => out.push(t), { maxBuffer: 16 });

    sink.write("x".repeat(20));
    sink.write(TOKEN.slice(0, 5));
    sink.write(TOKEN.slice(5));
    sink.flush();

    const joined = out.join("");
    expect(joined).not.toContain(TOKEN);
    expect(joined).toContain("[redacted:ANTHROPIC_API_KEY]");
    // Nothing was dropped, only redacted — a sink that silently eats output is
    // its own incident.
    expect(joined.startsWith("x".repeat(20))).toBe(true);
  });

  it("flush on an empty buffer emits nothing at all", () => {
    const out: string[] = [];
    const sink = createScrubbedSink((t) => out.push(t));
    sink.flush();
    sink.flush();
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1F/N-2 — the safe split point was a single unordered pass
// ---------------------------------------------------------------------------

/**
 * The panel supplied the repro rather than the theory, so this suite uses it.
 *
 * `safeSplitIndex` pulls the emission point back to before any proper prefix of
 * a registered value sitting at the end of the emitted region. Pulling it back
 * MOVES that end — so a secret already iterated, and cleared against the OLD
 * position, can have its prefix sitting at the new one. One pass over the
 * registry therefore leaks the prefix of whichever secret was iterated first.
 *
 * It is the real registration order in this repo. `readTarget()` registers the
 * anon/publishable key on the first `createDb()`; ANTHROPIC_API_KEY is
 * registered later, by the first skill that reads it. Map iteration is insertion
 * order, so the anon key is iteration 1 and the model key is iteration 2 — and
 * iteration 2 is the one that moves `safe`.
 *
 * `scrub()` does not rescue it: the JWT pattern needs three dot-separated
 * segments and a 60-character head has two.
 */
describe("1F/N-2 — pulling the cut back for one secret must re-examine the rest", () => {
  // Shaped like a JWT so the residual is realistic, assembled from parts so no
  // whole credential-looking string sits in tracked source.
  const ANON_JWT = ["eyJ", "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".", "e30", ".", "c2ln"].join("");
  const MODEL_KEY = ["sk-", "ant-", "api03-", "7Qw9ZtL", "0000000000000000"].join("");

  it("leaves no prefix of ANY registered secret in the emitted region", () => {
    registerSecretValue("VITE_SUPABASE_ANON_KEY", ANON_JWT); // registered first, as in the app
    registerSecretValue("ANTHROPIC_API_KEY", MODEL_KEY);

    const anonHead = ANON_JWT.slice(0, 30);
    const modelHead = MODEL_KEY.slice(0, 20);
    const buffer = "x".repeat(1024) + anonHead + modelHead;

    const cut = safeSplitIndex(buffer, buffer.length);
    const emitted = buffer.slice(0, cut);

    // The single-pass version cut back only for MODEL_KEY, which left anonHead
    // sitting inside `emitted` with nothing left to re-examine it.
    expect(emitted).not.toContain(anonHead);
    expect(emitted).not.toContain(modelHead);
    expect(cut).toBe(1024);
  });

  it("does not leak it through the sink either, which is where it would be seen", () => {
    registerSecretValue("VITE_SUPABASE_ANON_KEY", ANON_JWT);
    registerSecretValue("ANTHROPIC_API_KEY", MODEL_KEY);

    const out: string[] = [];
    const sink = createScrubbedSink((t) => out.push(t), { maxBuffer: 1024 });

    // A child process writing a long line with no newline in it: the cap fires,
    // and what goes out must carry no fragment of either key.
    sink.write("x".repeat(1024) + ANON_JWT.slice(0, 30) + MODEL_KEY.slice(0, 20));

    const joined = out.join("");
    expect(joined).not.toContain(ANON_JWT.slice(0, 30));
    expect(joined).not.toContain(MODEL_KEY.slice(0, 20));
  });

  it("still completes and redacts both once the rest of the stream arrives", () => {
    // A guard that holds output forever is its own incident. The held remainder
    // has to redact normally when the values complete.
    registerSecretValue("VITE_SUPABASE_ANON_KEY", ANON_JWT);
    registerSecretValue("ANTHROPIC_API_KEY", MODEL_KEY);

    const out: string[] = [];
    const sink = createScrubbedSink((t) => out.push(t), { maxBuffer: 1024 });

    sink.write("x".repeat(1024) + ANON_JWT.slice(0, 30));
    sink.write(ANON_JWT.slice(30) + " " + MODEL_KEY);
    sink.flush();

    const joined = out.join("");
    expect(joined).toContain("[redacted:VITE_SUPABASE_ANON_KEY]");
    expect(joined).toContain("[redacted:ANTHROPIC_API_KEY]");
    expect(joined).not.toContain(ANON_JWT);
    expect(joined).not.toContain(MODEL_KEY);
    // Nothing dropped: every "x" still there.
    expect(joined.split("x").length - 1).toBe(1024);
  });

  it("terminates on a buffer that is nothing but overlapping prefixes", () => {
    // The fixpoint loop must not spin: `safe` strictly decreases on every
    // repeat and is bounded below by 0. Asserted rather than assumed, because a
    // non-terminating guard in a log sink hangs the process it was protecting.
    registerSecretValue("ANTHROPIC_API_KEY", MODEL_KEY);
    registerSecretValue("VITE_SUPABASE_ANON_KEY", ANON_JWT);
    const buffer = MODEL_KEY.slice(0, 10) + ANON_JWT.slice(0, 10) + MODEL_KEY.slice(0, 10);
    expect(safeSplitIndex(buffer, buffer.length)).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 1F/N-3 — a line is not a safe unit for every credential shape
// ---------------------------------------------------------------------------

/**
 * The sink's stated premise was: "a credential does not contain a newline, so a
 * complete line contains whole credentials or none, and `scrub()` on that line
 * is exact." That premise is false for the FIRST entry in the scrubber's own
 * pattern list. A PEM block is three parts separated by newlines, so line
 * buffering hands `scrub()` the BEGIN line on its own — where nothing matches —
 * then the body, then the END, and all three go out in cleartext.
 *
 * `scrub()` on the unsplit text returns `[redacted:PRIVATE_KEY]`, so this is a
 * REGRESSION against 1C rather than a gap 1C shared. And the sink is the rail
 * that child-process stdout actually goes through, which is exactly where PEMs
 * and service-account JSON turn up.
 */
describe("1F/N-3 — multi-line credential shapes survive the sink", () => {
  // Assembled from parts: a whole PEM-looking block sitting in tracked source is
  // what check:env exists to stop. The body is deliberate nonsense.
  const BEGIN = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const END = ["-----END", "PRIVATE KEY-----"].join(" ");
  const BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ";
  const PEM = [BEGIN, BODY, BODY, END].join("\n");

  const drain = (chunks: string[], options?: { maxBuffer?: number }) => {
    const out: string[] = [];
    const sink = createScrubbedSink((t) => out.push(t), options);
    for (const c of chunks) sink.write(c);
    sink.flush();
    return out.join("");
  };

  it("scrub() on the unsplit text redacts it — this is what the sink must match", () => {
    expect(scrub(PEM)).toBe("[redacted:PRIVATE_KEY]");
  });

  it("redacts a PEM written as one chunk with its newlines in it", () => {
    const joined = drain([PEM + "\n"]);
    expect(joined).not.toContain(BODY);
    expect(joined).toBe("[redacted:PRIVATE_KEY]" + "\n");
  });

  it("redacts a PEM arriving one line at a time, as a child process writes it", () => {
    const joined = drain([BEGIN + "\n", BODY + "\n", BODY + "\n", END + "\n"]);
    expect(joined).not.toContain(BODY);
    expect(joined).not.toContain(BEGIN);
    expect(joined).toBe("[redacted:PRIVATE_KEY]" + "\n");
  });

  it("emits nothing while the block is open — not even the BEGIN line", () => {
    const out: string[] = [];
    const sink = createScrubbedSink((t) => out.push(t));
    sink.write(BEGIN + "\n");
    expect(out).toEqual([]); // the LINE is complete; the CREDENTIAL is not
    sink.write(BODY + "\n");
    expect(out).toEqual([]);
    sink.write(END + "\n");
    expect(out.join("")).toBe("[redacted:PRIVATE_KEY]" + "\n");
  });

  it("does not hold ordinary lines hostage before or after the block", () => {
    const joined = drain(["before" + "\n", BEGIN + "\n", BODY + "\n", END + "\n", "after" + "\n"]);
    expect(joined).toBe("before" + "\n" + "[redacted:PRIVATE_KEY]" + "\n" + "after" + "\n");
  });

  it("lets an ordinary line through immediately when nothing multi-line is open", () => {
    const out: string[] = [];
    const sink = createScrubbedSink((t) => out.push(t));
    sink.write("one" + "\n" + "two" + "\n");
    expect(out).toEqual(["one" + "\n", "two" + "\n"]);
  });

  it("does not leak the head of an unterminated block when the cap fires", () => {
    // The point of holding is lost if the pressure valve hands out the first
    // few hundred bytes of the key instead. `safeSplitIndex` cannot help here:
    // a PEM is matched by SHAPE, never registered, so nothing knows its length.
    // What the sink does know is exactly where the block starts.
    const joined = drain(["filler" + "\n", BEGIN + "\n", "A".repeat(400) + "\n"], { maxBuffer: 64 });
    expect(joined).not.toContain(BEGIN);
    expect(joined).not.toContain("AAAA");
    expect(joined).toContain("[redacted:PRIVATE_KEY]");
    // The ordinary line in front of it is not held hostage by the block behind.
    expect(joined.startsWith("filler" + "\n")).toBe(true);
  });

  it("flush() redacts a block that never closed rather than dumping it", () => {
    // End of stream is not a reason to hand over key material. An unterminated
    // BEGIN block is still the head of a private key.
    const joined = drain([BEGIN + "\n", BODY + "\n"]);
    expect(joined).not.toContain(BODY);
    expect(joined).not.toContain(BEGIN);
    expect(joined).toContain("[redacted:PRIVATE_KEY]");
  });
});
