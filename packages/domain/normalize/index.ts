/**
 * SPEC 4A — the load normalizer's public surface.
 *
 * `normalizeLoad` and `NormalizedLoad` are the interface the spec freezes. The
 * helpers below are exported because the acceptance suite and later tickets
 * (3B's money input, 3C's ordered stops, P-39's grouping) need to call them
 * directly; nothing here reaches the database, and nothing here is a row.
 */

export { normalizeLoad } from "./normalizeLoad.ts";
export {
  parseMoneyToCents,
  formatCents,
  type MoneyParse,
  type MoneyRejectReason,
} from "./money.ts";
export { locationKey, normalizeCity, resolveLocation, type LocationResolve } from "./location.ts";
export { canonical, canonicalize, collectLeaves, renderLeaf, type Leaf } from "./canonical.ts";
export { sha256, sha256Bytes } from "./sha256.ts";
export { findDenylistedKeys } from "./schema.ts";
export {
  DENYLISTED_KEYS,
  type Accessorial,
  type Broker,
  type CallSite,
  type Detention,
  type DenylistedKey,
  type EquipmentCode,
  type Load,
  type LoadSource,
  type MissingField,
  type MissingFieldReason,
  type MoneyOrigin,
  type NormalizedLoad,
  type NormalizeLoadResult,
  type ProposedMoney,
  type ResolvedLocation,
  type Stop,
  type StopType,
  type UntrustedText,
} from "./types.ts";
