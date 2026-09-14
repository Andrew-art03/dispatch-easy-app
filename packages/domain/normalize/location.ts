/**
 * SPEC 4A — location resolution and the location half of `dedupeHash`.
 *
 * "Location normalisation is RULED, not an open position: city + state
 * abbreviation only, zips resolved via a static table, and an unresolvable
 * location returns NEEDS_INPUT rather than hashing the raw string. A hash over
 * inconsistent text silently stops grouping anything, which is worse than
 * failing loudly."
 *
 * So the failure mode here is deliberately noisy. An unknown zip is a missing
 * fact a human fixes in a second; a location key built from "DFW" that does not
 * match one built from "Dallas, TX" is a grouping feature that quietly does
 * nothing and that nobody notices for a month.
 */

import type { ResolvedLocation, UntrustedText } from "./types.ts";

export type LocationResolve =
  | { ok: true; value: ResolvedLocation }
  | { ok: false; reason: "absent" | "unresolvable" | "ambiguous"; detail: string };

/** USPS two-letter codes, keyed by the full state name we accept in text. */
const STATE_BY_NAME: Readonly<Record<string, string>> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

const STATE_CODES: ReadonlySet<string> = new Set(Object.values(STATE_BY_NAME));

/**
 * Static zip seed table. SPEC 4A requires zips to resolve "via a static table"
 * and a bare UNKNOWN zip to be `NEEDS_INPUT` — which is what makes the table's
 * size a data question and not a correctness one. Growing it is a data ticket;
 * an entry is never inferred at runtime.
 */
const ZIP_TABLE: Readonly<Record<string, { city: string; state: string }>> = {
  "75201": { city: "Dallas", state: "TX" },
  "75202": { city: "Dallas", state: "TX" },
  "30303": { city: "Atlanta", state: "GA" },
  "60601": { city: "Chicago", state: "IL" },
  "90021": { city: "Los Angeles", state: "CA" },
  "07102": { city: "Newark", state: "NJ" },
  "37201": { city: "Nashville", state: "TN" },
  "80202": { city: "Denver", state: "CO" },
};

/**
 * Airport / metro shorthand a broker or dispatcher types instead of a city. The
 * spec names `DFW` explicitly and scopes this to "while a static alias table
 * exists" — so it is a table, and an unlisted shorthand fails rather than guesses.
 */
const CITY_ALIASES: Readonly<Record<string, { city: string; state: string }>> = {
  DFW: { city: "Dallas", state: "TX" },
  ATL: { city: "Atlanta", state: "GA" },
  CHI: { city: "Chicago", state: "IL" },
  LAX: { city: "Los Angeles", state: "CA" },
};

/** Words that mean "we do not know yet" and must never resolve to a place. */
const PLACEHOLDERS: ReadonlySet<string> = new Set(["TBD", "TBA", "N/A", "NA", "UNKNOWN", "-", "?"]);

/** `dedupeHash` segment 1/2: trimmed, uppercased, internal whitespace collapsed. */
export function normalizeCity(city: string): string {
  return city.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Display casing — "dallas" and "DALLAS" both present as "Dallas". */
function displayCity(city: string): string {
  return city
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) =>
      word.length === 0 ? word : word[0]?.toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

function untrusted(value: string): UntrustedText {
  return { value, untrusted: true };
}

/** Resolve a trailing full state name of one, two or three words. */
function splitTrailingStateName(tokens: string[]): { state: string; rest: string[] } | undefined {
  for (const span of [3, 2, 1]) {
    if (tokens.length <= span) continue;
    const tail = tokens
      .slice(tokens.length - span)
      .join(" ")
      .toLowerCase();
    const code = STATE_BY_NAME[tail];
    if (code !== undefined) return { state: code, rest: tokens.slice(0, tokens.length - span) };
  }
  return undefined;
}

/**
 * Turn a location as written into `{ city, state, postalCode? }`, or say why not.
 *
 * Accepted, in this order: a bare zip in the table; a shorthand in the alias
 * table; `City, ST`; `City, State Name`; `City ST`; `City State Name`; any of
 * those with a trailing 5- or 9-digit zip.
 */
export function resolveLocation(input: unknown): LocationResolve {
  if (input === null || input === undefined) {
    return { ok: false, reason: "absent", detail: "no location" };
  }

  // A structured stop: { city, state, zip } — the broker_direct shape.
  if (typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    const city = record["city"];
    const state = record["state"] ?? record["stateCode"] ?? record["st"];
    const zip = record["zip"] ?? record["postalCode"] ?? record["postal_code"];
    const pieces = [city, state, zip].filter((v) => typeof v === "string" && v.trim() !== "");
    if (pieces.length === 0) {
      return { ok: false, reason: "absent", detail: "object carries no city/state/zip" };
    }
    const joined =
      typeof city === "string" && typeof state === "string"
        ? `${city}, ${state}${typeof zip === "string" ? ` ${zip}` : ""}`
        : pieces.join(" ");
    return resolveLocation(joined);
  }

  if (typeof input !== "string") {
    return { ok: false, reason: "unresolvable", detail: "location is not text" };
  }

  const text = input.trim().replace(/\s+/g, " ");
  if (text === "") return { ok: false, reason: "absent", detail: "empty location" };
  if (PLACEHOLDERS.has(text.toUpperCase())) {
    return { ok: false, reason: "unresolvable", detail: `placeholder location: ${text}` };
  }

  const raw = untrusted(input);

  // 1. A bare zip. In the table, or NEEDS_INPUT — never hashed as raw text.
  const bareZip = /^(\d{5})(?:-\d{4})?$/.exec(text);
  if (bareZip) {
    const key = bareZip[1] ?? "";
    const hit = ZIP_TABLE[key];
    if (!hit) {
      return { ok: false, reason: "unresolvable", detail: `zip ${key} is not in the static table` };
    }
    return { ok: true, value: { city: hit.city, state: hit.state, postalCode: key, raw } };
  }

  // 2. Shorthand.
  const alias = CITY_ALIASES[text.toUpperCase()];
  if (alias) {
    return { ok: true, value: { city: alias.city, state: alias.state, raw } };
  }

  // 3. Peel a trailing zip off "Dallas, TX 75201" / "Dallas Texas 75201".
  let body = text;
  let postalCode: string | undefined;
  const trailingZip = /[\s,]+(\d{5})(?:-\d{4})?$/.exec(body);
  if (trailingZip) {
    postalCode = trailingZip[1];
    body = body.slice(0, trailingZip.index).trim();
  }

  // 4. City + state, comma-separated or not.
  let city: string | undefined;
  let state: string | undefined;

  const comma = body.lastIndexOf(",");
  if (comma > 0) {
    const head = body.slice(0, comma).trim();
    const tail = body.slice(comma + 1).trim();
    const code = tail.length === 2 ? tail.toUpperCase() : STATE_BY_NAME[tail.toLowerCase()];
    if (code !== undefined && STATE_CODES.has(code)) {
      city = head;
      state = code;
    }
  }

  if (state === undefined && body !== "") {
    const tokens = body.replace(/,/g, " ").replace(/\s+/g, " ").trim().split(" ");
    const last = tokens[tokens.length - 1] ?? "";
    if (tokens.length > 1 && last.length === 2 && STATE_CODES.has(last.toUpperCase())) {
      state = last.toUpperCase();
      city = tokens.slice(0, -1).join(" ").trim();
    } else {
      const named = splitTrailingStateName(tokens);
      if (named) {
        state = named.state;
        city = named.rest.join(" ").trim();
      }
    }
  }

  // 5. No state in the text: a KNOWN zip can still supply one. An unknown one cannot.
  if (state === undefined && postalCode !== undefined) {
    const hit = ZIP_TABLE[postalCode];
    if (hit) {
      city = city ?? hit.city;
      state = hit.state;
    }
  }

  if (state === undefined || city === undefined || city === "") {
    return { ok: false, reason: "unresolvable", detail: `cannot resolve to city/state: ${text}` };
  }

  const value: ResolvedLocation = { city: displayCity(city), state, raw };
  if (postalCode !== undefined) value.postalCode = postalCode;
  return { ok: true, value };
}

/** `dedupeHash` segments 1 and 2: `${state}:${normalizeCity(city)}`. No zip, no street. */
export function locationKey(loc: ResolvedLocation): string {
  return `${loc.state}:${normalizeCity(loc.city)}`;
}
