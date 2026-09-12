/**
 * The scrubbing SINK — TICKET 1F item 5 (findings H-6 and H-7).
 *
 * THE DEFECT THIS FIXES. 1C gave us `scrub()` for strings and `scrubDeep()` for
 * objects, and both are correct. Neither is a boundary. They are functions a
 * caller has to remember to call, on a value the caller has to hand over in one
 * piece, before anything else has happened to it. Two ways that fails, and both
 * are ordinary code rather than anything exotic:
 *
 *   H-6 — SCRUB AFTER SERIALIZATION, NOT BEFORE. `scrubDeep(obj)` walks an
 *   object and redacts the strings it finds. What reaches the terminal is not
 *   that object, it is the STRING some formatter made out of it — via
 *   `toString`, a getter, a `JSON.stringify` replacer, an Error's stack. A value
 *   that was not a plain string property at walk time can still be a plain
 *   credential in the output. Scrubbing the rendered text cannot be fooled that
 *   way, because by then there is nothing left to render.
 *
 *   H-7 — SCRUB AFTER CONCATENATION. A stream is not a sequence of complete
 *   messages. `write(secret.slice(0, 4))` then `write(secret.slice(4))` puts a
 *   whole credential on stdout while no single call ever saw one, so a
 *   per-call scrub is looking at two innocent fragments. This is the normal
 *   behaviour of a piped child process, not an edge case.
 *
 * So: one place everything on its way to a human or a vendor goes through, and
 * the scrub happens at the last possible moment — after formatting, after
 * joining, after the stream has been reassembled.
 *
 * WHAT THIS IS NOT. It is not a replacement for `scrub()` / `scrubDeep()`, which
 * are still the right tools for a value you are about to put somewhere
 * structured (an audit row, a Sentry event). It is the backstop for everything
 * that ends up as text, and the two rails are deliberate duplication — rule 6
 * does not get a single point of failure.
 */

import { safeSplitIndex, scrub } from "./secrets.ts";

// ---------------------------------------------------------------------------
// H-6 — formatting, then scrubbing
// ---------------------------------------------------------------------------

/**
 * Render one console-style argument to text, the way a terminal would see it.
 *
 * Deliberately total: a formatter that throws inside a logger turns a log line
 * into an outage, and a formatter that throws inside an ERROR logger loses the
 * error it was called to report. Anything unrenderable degrades to a placeholder
 * rather than propagating.
 */
export function renderArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  // A Buffer/Uint8Array is the form a child process's output arrives in, and
  // `String(buf)` on a Buffer already gives utf8 — but a bare Uint8Array would
  // render as "1,2,3". Decode explicitly so both behave the same.
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      // Cycles, BigInt, a throwing toJSON. `scrubDeep` handles cycles for
      // structured sinks; here the text is what matters and it must not throw.
      return "[unserialisable]";
    }
  }
  try {
    return String(value);
  } catch {
    return "[unrenderable]";
  }
}

/**
 * Format console-style arguments and scrub the RESULT — the H-6 order, and the
 * only order that is safe.
 *
 * Concatenating first is the load-bearing part. `format("Bearer", token)`
 * produces one string containing the whole credential; scrubbing each argument
 * separately would look at "Bearer" and at a token that may itself only be half
 * of what the line finally says.
 */
export function formatAndScrub(...args: unknown[]): string {
  return scrub(args.map(renderArg).join(" "));
}

// ---------------------------------------------------------------------------
// H-7 — the stream sink
// ---------------------------------------------------------------------------

export interface ScrubbedSink {
  /** Accept a chunk. Nothing is emitted until a line is complete (see below). */
  write(chunk: string | Uint8Array): void;
  /** Emit whatever is buffered, scrubbed. Call when the stream ends. */
  flush(): void;
}

/**
 * Default cap on how much unterminated output is held before the sink gives up
 * waiting for a newline. Generous: a held buffer costs memory, an emitted
 * fragment costs a credential.
 */
const DEFAULT_MAX_BUFFER = 1 << 20; // 1 MiB

/**
 * A sink that scrubs reassembled output rather than individual writes.
 *
 * WHY LINE BUFFERING RATHER THAN A FIXED HOLD-BACK. The obvious design — keep
 * the last N characters, emit the rest — does not actually work, and it is worth
 * writing down why so nobody "simplifies" it back. A secret straddling the cut
 * point has its first characters in the part being emitted, so the fragment goes
 * out unredacted; no choice of N fixes that, because the leak is the prefix, not
 * the remainder. Holding until a line is complete has no such boundary: a
 * credential does not contain a newline, so a complete line contains whole
 * credentials or none, and `scrub()` on that line is exact.
 *
 * THE CAP, and how it avoids reintroducing the bug. A stream that never emits a
 * newline would buffer forever, so there is a limit. On reaching it the sink
 * cannot simply "emit all but the last N characters" — that is the broken design
 * described above, and the first draft of this file did it and was caught by its
 * own test. Instead `safeSplitIndex()` pulls the emission point back to before
 * any partial registered value sitting at the end of it, so the text that goes
 * out provably contains no fragment of a known secret and the rest stays
 * buffered until it completes.
 *
 * THE RESIDUAL, stated rather than hidden: that is exact for the REGISTRY rail,
 * which knows what it is looking for. A pattern-matched credential — one never
 * registered, so nothing knows its length — can still be split across a forced
 * emission. Accepted, and it is why `readSecret` / `registerSecretValue` being
 * the normal path is the thing that matters.
 */
export function createScrubbedSink(
  emit: (text: string) => void,
  options: { maxBuffer?: number } = {},
): ScrubbedSink {
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  let buffer = "";

  const emitCompleteLines = () => {
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      // The newline goes out with its line, so the sink is transparent to
      // anything downstream that cares about line structure.
      emit(scrub(buffer.slice(0, newline + 1)));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  };

  return {
    write(chunk) {
      buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      emitCompleteLines();

      if (buffer.length > maxBuffer) {
        // No newline in sight. Emit as much as can be cut away without
        // orphaning the start of a registered secret; keep the remainder so it
        // can still match once the rest of the value arrives.
        const cut = safeSplitIndex(buffer, buffer.length);
        if (cut > 0) {
          emit(scrub(buffer.slice(0, cut)));
          buffer = buffer.slice(cut);
        }
      }
    },

    flush() {
      if (buffer === "") return;
      emit(scrub(buffer));
      buffer = "";
    },
  };
}

// ---------------------------------------------------------------------------
// The console boundary
// ---------------------------------------------------------------------------

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const CONSOLE_METHODS: readonly ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

/**
 * Route every `console.*` call through `formatAndScrub`. Returns the function
 * that puts the originals back.
 *
 * One string is passed on, never the original arguments: handing the formatted
 * text to the real method is what guarantees the thing printed is the thing that
 * was scrubbed. Passing the arguments through and hoping the terminal formats
 * them the same way would reintroduce H-6 at the last step.
 *
 * Idempotent. Installing twice would otherwise nest the wrappers and, worse,
 * capture an already-wrapped method as the "original", so the restore function
 * from the first install would never get back to the real console.
 */
/** Consoles currently wrapped, so a second install is a no-op rather than a nesting. */
const installed = new WeakSet<Console>();

export function installScrubbedConsole(target: Console = console): () => void {
  if (installed.has(target)) return () => undefined;

  const slots = target as unknown as Record<string, unknown>;
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();

  for (const method of CONSOLE_METHODS) {
    const original = target[method] as (...args: unknown[]) => void;
    if (typeof original !== "function") continue;
    originals.set(method, original);
    slots[method] = (...args: unknown[]) => {
      original.call(target, formatAndScrub(...args));
    };
  }
  installed.add(target);

  return () => {
    for (const [method, original] of originals) slots[method] = original;
    installed.delete(target);
  };
}
