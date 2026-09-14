/**
 * SPEC 4A — the frozen interface.
 *
 * Every type below is copied from "The interface - frozen (Grok 1.1, 1.2)" in
 * `docs/specs/SPEC-4A-NORMALIZER.md` v2 (SIGNED). Nothing here is illustrative:
 * the spec says a second implementer builds from that block, so this file is a
 * transcription, not a design.
 *
 * Banned in the output type, and asserted at the bottom of this file:
 *   - `Date`            — windows are ISO-8601 strings; a Date is a clock value
 *   - float money       — every amount is integer cents (R3)
 *   - bare `string` on prose fields — they are `UntrustedText` (R2.2)
 */

export type LoadSource = "paste" | "screenshot" | "email" | "broker_direct" | "manual";

/**
 * Free text that arrived from outside. The marker is the point: a later layer
 * cannot pick this up and treat it as trusted config without deleting a field
 * that a test asserts is present (acceptance 16).
 */
export type UntrustedText = { value: string; untrusted: true };

export type MoneyOrigin = "stated_text" | "ocr_proposal" | "broker_payload";

/**
 * R3. `cents` is a finite integer, and no float is formed anywhere on the way
 * to it — see `money.ts`. `verified_by` is deliberately not a member: a document
 * never mints a human confirmation (Boundary vs Group 2, A-4).
 */
export type ProposedMoney = {
  cents: number;
  currency: "USD";
  confidence?: number;
  origin: MoneyOrigin;
};

export type StopType = "pickup" | "delivery" | "other";

export type ResolvedLocation = {
  city: string;
  state: string;
  postalCode?: string;
  raw: UntrustedText;
};

export type Stop = {
  seq: number;
  type: StopType;
  location: ResolvedLocation;
  windowStart?: string;
  windowEnd?: string;
  notes?: UntrustedText;
};

export type EquipmentCode = "VAN" | "REEFER" | "FLATBED" | "STEPDECK" | "OTHER";

export type Accessorial = {
  kind: string | "unknown";
  amountCents?: ProposedMoney;
  raw: UntrustedText;
};

export type Detention = {
  amountCents?: ProposedMoney;
  unit?: "hour" | "day" | "unknown";
  raw: UntrustedText;
};

/** Rule 15: the field is `rateConLinehaulCents`, never `rate`. */
export type Load = {
  rateConLinehaulCents?: ProposedMoney;
  rateKind?: "flat" | "per_mile";
  miles?: { value: number; unit: "mi" };
  weightLbs?: number;
  commodity?: UntrustedText;
  equipment?: EquipmentCode;
  equipmentRaw?: UntrustedText;
  specialInstructions?: UntrustedText;
  notes?: UntrustedText;
  referenceNumbers: UntrustedText[];
  accessorials: Accessorial[];
  detention?: Detention;
};

export type Broker = { name?: UntrustedText; mc?: string; phone?: string; raw: UntrustedText };

/** All four fields come from the CALL SITE, never from the payload. */
export type Provenance = {
  source: LoadSource;
  receivedAt: string;
  extractor?: { name: string; version: string };
  contentHash: string;
};

export type NormalizedLoad = {
  load: Load;
  stops: Stop[];
  broker?: Broker;
  raw_payload: unknown;
  unmapped: UntrustedText[];
  moneyParseIncomplete: boolean;
  provenance: Provenance;
  dedupeHash: string;
};

export type MissingFieldReason = "absent" | "unparseable" | "unresolvable" | "ambiguous";

export type MissingField = {
  path: string;
  reason: MissingFieldReason;
  rawExcerpt: UntrustedText;
};

export type NormalizeLoadResult =
  | { ok: true; value: NormalizedLoad }
  | { ok: false; code: "NEEDS_INPUT"; fields: MissingField[]; partial: Partial<NormalizedLoad> };

export type CallSite = {
  /** ISO-8601, from the caller. NEVER from raw, never `Date.now()`. */
  receivedAt: string;
  /** Required for source "screenshot" | "email". */
  extractor?: { name: string; version: string };
};

/* ───────────────────────── R2.1 — the denylist ─────────────────────────────
 *
 * "the ban is a denylist, not a phrase" (Grok 1.9). These keys must be ABSENT
 * from `load`, `stops`, `broker` and `provenance` after parse, even when they
 * are present in `raw`. `raw_payload` and `unmapped` may carry them as inert
 * data — that is where they belong, and it is where the fixture finds them.
 *
 * Three enforcement layers, because a convention is not a control:
 *   compile time  — `_DenylistIsStructurallyImpossible` below
 *   parse time    — the `.strict()` zod schemas in `schema.ts`
 *   fixture time  — `tests/fixtures/injection-machine-columns.json`
 */
export const DENYLISTED_KEYS = [
  "org_id",
  "orgId",
  "tenant",
  "status",
  "exception",
  "humanApproved",
  "approval",
  "approved",
  "verdict",
  "action",
  "role",
  "authUserId",
  "terms_hash",
  "score",
  "verified_by",
] as const;

export type DenylistedKey = (typeof DENYLISTED_KEYS)[number];

/** Depth ladder so the recursive key walk below terminates. */
type Prev = [never, 0, 1, 2, 3, 4, 5, 6];

/** Every property name reachable in `T`, to a bounded depth. */
type DeepKeys<T, D extends number = 7> = [D] extends [never]
  ? never
  : T extends readonly (infer U)[]
    ? DeepKeys<U, Prev[D]>
    : T extends object
      ? { [K in keyof T & string]: K | DeepKeys<NonNullable<T[K]>, Prev[D]> }[keyof T & string]
      : never;

type AssertTrue<T extends true> = T;

/**
 * COMPILE-TIME ASSERTION (R2.1). If anyone ever adds `status`, `humanApproved`,
 * `verified_by` or any other denylisted key to `Load`, `Stop`, `Broker` or
 * `Provenance`, `tsc --noEmit` fails here — before a test runs, before a review.
 */
export type _DenylistIsStructurallyImpossible = AssertTrue<
  [Extract<DeepKeys<Load | Stop | Broker | Provenance>, DenylistedKey>] extends [never]
    ? true
    : false
>;

/**
 * COMPILE-TIME ASSERTION: no `Date` anywhere in the mapped output. Windows are
 * ISO-8601 strings; a `Date` is a clock value and would break determinism.
 */
type HasDate<T, D extends number = 7> = [D] extends [never]
  ? false
  : T extends Date
    ? true
    : T extends readonly (infer U)[]
      ? HasDate<U, Prev[D]>
      : T extends object
        ? true extends { [K in keyof T]: HasDate<NonNullable<T[K]>, Prev[D]> }[keyof T]
          ? true
          : false
        : false;

export type _NoDateInMappedOutput = AssertTrue<
  HasDate<Load | Stop | Broker | Provenance> extends false ? true : false
>;
