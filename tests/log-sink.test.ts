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
import { registerSecretValue, resetSecretRegistry, scrub, scrubDeep } from "../agents/secrets.ts";

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
