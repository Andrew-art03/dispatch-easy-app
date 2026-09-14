/**
 * SPEC 4A — the parse-time half of R2.1.
 *
 * "normalisation is Zod plus code, so the same input always produces the same
 * output and a bad extraction fails visibly instead of being smoothed over."
 *
 * These schemas are a GUARD, not the type source. `types.ts` is the frozen
 * interface; this file re-validates the object 4A just built, with every object
 * `.strict()`, so that a denylisted key (`org_id`, `status`, `humanApproved`,
 * `verified_by`, …) cannot reach `load` / `stops` / `broker` / `provenance` even
 * through a code path a future edit introduces. The compile-time assertion in
 * `types.ts` stops it at the type level; this stops it at runtime; the fixture in
 * `tests/fixtures/injection-machine-columns.json` proves both with a real payload.
 *
 * Three layers for one rule is not belt-and-braces. R2 says the ban is
 * "structural, not a convention", and a rule enforced in exactly one place is a
 * convention with good intentions.
 */

import { z } from "zod";

import { DENYLISTED_KEYS } from "./types.ts";

const untrustedText = z
  .object({
    value: z.string(),
    untrusted: z.literal(true),
  })
  .strict();

const proposedMoney = z
  .object({
    // R3: finite INTEGER cents. `z.number().int()` is the schema-level restatement
    // of the rule the parser enforces by never forming a float in the first place.
    cents: z.number().int().finite(),
    currency: z.literal("USD"),
    confidence: z.number().min(0).max(1).optional(),
    origin: z.enum(["stated_text", "ocr_proposal", "broker_payload"]),
    // `verified_by` is absent by construction: `.strict()` rejects it if a future
    // edit ever copies 5B's money shape through 4A (Boundary vs Group 2, A-4).
  })
  .strict();

const resolvedLocation = z
  .object({
    city: z.string().min(1),
    state: z.string().regex(/^[A-Z]{2}$/),
    postalCode: z.string().optional(),
    raw: untrustedText,
  })
  .strict();

export const stopSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    type: z.enum(["pickup", "delivery", "other"]),
    location: resolvedLocation,
    windowStart: z.string().optional(),
    windowEnd: z.string().optional(),
    notes: untrustedText.optional(),
  })
  .strict();

export const loadSchema = z
  .object({
    rateConLinehaulCents: proposedMoney.optional(),
    rateKind: z.enum(["flat", "per_mile"]).optional(),
    miles: z
      .object({ value: z.number().int(), unit: z.literal("mi") })
      .strict()
      .optional(),
    weightLbs: z.number().int().optional(),
    commodity: untrustedText.optional(),
    equipment: z.enum(["VAN", "REEFER", "FLATBED", "STEPDECK", "OTHER"]).optional(),
    equipmentRaw: untrustedText.optional(),
    specialInstructions: untrustedText.optional(),
    notes: untrustedText.optional(),
    referenceNumbers: z.array(untrustedText),
    accessorials: z.array(
      z
        .object({
          kind: z.string(),
          amountCents: proposedMoney.optional(),
          raw: untrustedText,
        })
        .strict(),
    ),
    detention: z
      .object({
        amountCents: proposedMoney.optional(),
        unit: z.enum(["hour", "day", "unknown"]).optional(),
        raw: untrustedText,
      })
      .strict()
      .optional(),
  })
  .strict();

export const brokerSchema = z
  .object({
    name: untrustedText.optional(),
    mc: z.string().optional(),
    phone: z.string().optional(),
    raw: untrustedText,
  })
  .strict();

export const provenanceSchema = z
  .object({
    source: z.enum(["paste", "screenshot", "email", "broker_direct", "manual"]),
    receivedAt: z.string(),
    extractor: z.object({ name: z.string(), version: z.string() }).strict().optional(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/**
 * The mapped half of `NormalizedLoad`. `raw_payload` and `unmapped` are NOT
 * validated here on purpose — they are the channels that are allowed to carry
 * anything, including every denylisted key, as inert data.
 */
export const mappedSchema = z
  .object({
    load: loadSchema,
    stops: z.array(stopSchema),
    broker: brokerSchema.optional(),
    provenance: provenanceSchema,
  })
  .strict();

export type MappedParts = {
  load: unknown;
  stops: unknown;
  broker?: unknown;
  provenance: unknown;
};

export type MappedValidation = { ok: true } | { ok: false; detail: string };

/**
 * Validate the mapped output. A failure here is a 4A BUG, not bad input — the
 * caller's payload has already been through every rule by this point — so it is
 * surfaced as `NEEDS_INPUT` on the offending path rather than thrown, which keeps
 * the "never throw for an expected absence" contract while still failing loudly.
 */
export function validateMapped(parts: MappedParts): MappedValidation {
  const candidate: Record<string, unknown> = {
    load: parts.load,
    stops: parts.stops,
    provenance: parts.provenance,
  };
  if (parts.broker !== undefined) candidate["broker"] = parts.broker;

  const result = mappedSchema.safeParse(candidate);
  if (result.success) return { ok: true };
  const first = result.error.issues[0];
  const path = first?.path.join(".") ?? "(root)";
  return { ok: false, detail: `${path}: ${first?.message ?? "invalid"}` };
}

/**
 * Belt-and-braces walk used by the acceptance fixture: no denylisted key may
 * appear anywhere in the mapped output, at any depth, under any parent.
 */
export function findDenylistedKeys(value: unknown, path = ""): string[] {
  const denied: ReadonlySet<string> = new Set<string>(DENYLISTED_KEYS);
  const hits: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${at}[${index}]`));
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const here = at === "" ? key : `${at}.${key}`;
        if (denied.has(key)) hits.push(here);
        walk(child, here);
      }
    }
  };
  walk(value, path);
  return hits;
}
