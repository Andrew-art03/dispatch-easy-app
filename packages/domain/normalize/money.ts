/**
 * SPEC 4A — R3: currency text becomes INTEGER CENTS here, or 3B's discipline is
 * already broken before 3B is called.
 *
 * The defect this file exists to stop is one line long and looks harmless:
 *
 *     const cents = Math.round(parseFloat("$3,200.00".replace(/[$,]/g, "")) * 100)
 *
 * `parseFloat` forms a float, `* 100` compounds it, and a float has now entered
 * the money path. SPEC 3B mandates integer cents end to end; by the time 3B
 * receives the number the damage is invisible from inside 3B. So: no `parseFloat`,
 * no `Number(x) * 100`, no float at any point. Digits are kept as TEXT, padded as
 * TEXT, and turned into a number exactly once, from an integer-valued string.
 */

import type { MoneyOrigin, ProposedMoney } from "./types.ts";

export type MoneyRejectReason =
  /** nothing there at all */
  | "absent"
  /** text that is not a number we will accept: formula, scientific, mixed separators, negatives */
  | "unparseable"
  /** a currency we do not price in, or a number whose currency cannot be established */
  | "ambiguous";

export type MoneyParse =
  { ok: true; value: ProposedMoney } | { ok: false; reason: MoneyRejectReason; detail: string };

/** `$3,200`, `3,200.00`, `3200.5`, `USD 3200`, `3200 USD`. Nothing else. */
const GROUPED = /^\d{1,3}(?:,\d{3})*(?:\.\d+)?$/;
const PLAIN = /^\d+(?:\.\d+)?$/;

/**
 * Currency codes and symbols that are NOT USD. Pilot currency is USD only and
 * "any other currency -> NEEDS_INPUT, never a guess" — a CAD rate read as USD is
 * a ~35% error in the driver's favour-looking direction, which is the worst kind.
 */
const NON_USD =
  /(?:\b(?:CAD|MXN|EUR|GBP|AUD|NZD|CHF|JPY|CNY|INR|BRL|SEK|NOK|DKK|PLN|ZAR)\b)|[€£¥₹₽₩]/i;

/** Arithmetic that means a spreadsheet cell leaked in, not a rate. */
const FORMULA = /^[=+@-]|[*^%]|(?:\d\s*[+*/]\s*\d)/;

/** `3.2e3` is 3200 to a float parser and a parse error to a human reading a rate con. */
const SCIENTIFIC = /\de[+-]?\d/i;

/**
 * Parse currency TEXT to integer cents, forming no float.
 *
 * `origin` is supplied by the caller because it is a fact about where the text
 * came from, not about the text. `confidence` likewise — it is only ever an
 * upstream extractor's number, never one 4A invents.
 */
export function parseMoneyToCents(
  text: unknown,
  origin: MoneyOrigin,
  confidence?: number,
): MoneyParse {
  // R3: "An input that is already a JS number is REJECTED." The float was formed
  // upstream; accepting it here and calling Math.round(n * 100) is the exact
  // defect R3 exists to stop, wearing a helpful-looking costume.
  if (typeof text === "number") {
    return {
      ok: false,
      reason: "unparseable",
      detail: "money arrived as a JS number; a float has already been formed upstream (R3)",
    };
  }
  if (typeof text !== "string") {
    return { ok: false, reason: "absent", detail: "money is not text" };
  }

  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reason: "absent", detail: "empty" };

  if (FORMULA.test(trimmed)) {
    return { ok: false, reason: "unparseable", detail: `formula or signed value: ${trimmed}` };
  }
  if (trimmed.includes("(") || trimmed.includes(")")) {
    return { ok: false, reason: "unparseable", detail: `parenthesised (negative): ${trimmed}` };
  }
  if (SCIENTIFIC.test(trimmed)) {
    return { ok: false, reason: "unparseable", detail: `scientific notation: ${trimmed}` };
  }
  if (NON_USD.test(trimmed)) {
    return { ok: false, reason: "ambiguous", detail: `not USD: ${trimmed}` };
  }

  // Strip exactly the decoration R3 allows: one optional `$`, an optional `USD`.
  let body = trimmed;
  const usd = /\bUSD\b/gi;
  const usdHits = body.match(usd)?.length ?? 0;
  if (usdHits > 1) {
    return { ok: false, reason: "unparseable", detail: `repeated currency code: ${trimmed}` };
  }
  body = body.replace(usd, " ");
  const dollarHits = (body.match(/\$/g) ?? []).length;
  if (dollarHits > 1) {
    return { ok: false, reason: "unparseable", detail: `repeated currency symbol: ${trimmed}` };
  }
  body = body.replace(/\$/g, " ").trim();
  // Whitespace inside the number ("3 200") is a grouping style we do not accept;
  // collapsing it would silently turn "3 200" into 3200 and "3 2" into 32.
  if (/\s/.test(body)) {
    return {
      ok: false,
      reason: "unparseable",
      detail: `unexpected text around the number: ${trimmed}`,
    };
  }
  if (body === "") return { ok: false, reason: "absent", detail: "currency marker with no number" };

  if (!GROUPED.test(body) && !PLAIN.test(body)) {
    // Catches "3.200,00" (both separators), stray letters, and anything else.
    return { ok: false, reason: "unparseable", detail: `not a USD amount: ${trimmed}` };
  }

  const parts = body.replace(/,/g, "").split(".");
  const whole = parts[0] ?? "";
  const frac = parts[1] ?? "";
  if (parts.length > 2) {
    return { ok: false, reason: "unparseable", detail: `multiple decimal points: ${trimmed}` };
  }
  if (frac.length > 2) {
    // "3,200.567" — three decimal places in a rate is not a rate, it is a parse
    // error wearing a costume. Rounding it here is exactly the silent loss R3 bans.
    return { ok: false, reason: "unparseable", detail: `more than two decimal places: ${trimmed}` };
  }

  // The only arithmetic in the whole file, and it is on a string of digits.
  const digits = `${whole}${frac.padEnd(2, "0")}`;
  const cents = Number(digits);
  if (!Number.isSafeInteger(cents)) {
    return {
      ok: false,
      reason: "unparseable",
      detail: `amount out of safe integer range: ${trimmed}`,
    };
  }

  const value: ProposedMoney = { cents, currency: "USD", origin };
  if (confidence !== undefined) value.confidence = confidence;
  return { ok: true, value };
}

/** `320050` -> `"3200.50"`. Used by the round-trip property test, never by the UI. */
export function formatCents(cents: number): string {
  const s = String(cents).padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}
