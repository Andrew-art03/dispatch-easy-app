/**
 * The process-kind test seam — 1F/N-4.
 *
 * `resetDeclaredProcessKind()` used to be exported from
 * `packages/config/process-kind.ts` itself. It un-declares an agent process,
 * which means rule 40's check in `createDb()` stops running for the rest of the
 * process — a bypass shipping from production source under a name that reads
 * like ordinary housekeeping.
 *
 * It lives here now. What that buys, stated plainly: an ESM export is reachable
 * by anything that can name the module, so this is a rail plus a name rather
 * than a structural impossibility. The rail is in `tests/lint-rails.test.ts` —
 * it scans the tree and fails if any file outside this one names the underlying
 * `__resetDeclaredProcessKind`, with a planted positive that is seen to fail.
 *
 * Tests import `resetDeclaredProcessKind` from HERE.
 */
import { __resetDeclaredProcessKind } from "../../packages/config/process-kind.ts";

/** Drop the declaration so a case can start from a clean process. */
export function resetDeclaredProcessKind(): void {
  __resetDeclaredProcessKind();
}
