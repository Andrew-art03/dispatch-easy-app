# NOT_BUILT_YET.md — ticket EZ-BUILD-01

Everything deferred, with the reason. This is not a wish list: a line here means
the builder consciously did not build it and named why.

Version-2 ideas go here too (BUILD_DEFAULTS §2). Part 3's 45 rows are parked by
design and are not itemised.

---

## Out of scope by rule, not by choice

| Item | Why | Rule |
|---|---|---|
| **3C — carrier brain** | Spec `SPEC-3C-CARRIER-BRAIN.md` is **UNSIGNED** | R-8 — 3B and 4A were both dispatched unsigned and both had to be withdrawn |
| **5A — upload gate** | Spec `SPEC-5A-UPLOAD-GATE.md` is **UNSIGNED**; A-1 (HEIC sniffing) and A-3 (the 20 MB cap is an estimate, not measured against real paperwork) are open inside it | R-8 |
| **12B — proof pack** | Built from Andrew's Freedom Trucking paperwork, which has not been supplied (`seed/README.md`) | BUILD_DEFAULTS §6 — never invent a trucking fact |
| **Front end, `src/**`** | The pilot is back end only; 35 of 44 front-end rows are done and every open one is Andrew's to check | BUILD_DEFAULTS §2 |
| **Prices, pricing copy, Stripe keys** | D-2 is Andrew's and he writes the numbers when ready. Slice 11 ships placeholders and an entitlement flag only | BUILD_DEFAULTS §2, guide Slice 11 |
| **Chrome extension on DAT** | Out for this freeze | CLAUDE.md rule 24 |
| **DAT / Truckstop / RateView numbers** | No signed partner paper | CLAUDE.md rule 19 |

## Deferred with a reason, may return

| Item | Why deferred | What would un-defer it |
|---|---|---|
| **Live apply of migration 0003 to a scratch database** | No Postgres driver installed (rule 30: a human reads the source first) and no `SCRATCH_DB_URL` here (rule 49: this session does not touch the real project) | D-CC-1 — a scratch connection string plus an approved driver, or Andrew applying it in the dashboard |
| **Live two-account RLS run (Slice 3)** | Same gap. The policy matrix and its SQL land and are asserted statically | D-CC-1 |
| **`ci.yml` gate lines** | This session's token deliberately has no `workflow` scope — an agent does not hold a credential that can rewrite its own CI | Rule 27; Andrew commits the lines. Every gate is wired into `bun run test` instead, which is already a CI step |
| **Re-pinning `bun.lock` off Lovable's private registry** | A clean clone gets 403 on nine packages. Re-pinning or vendoring without a ticket is exactly what BUILD_DEFAULTS §5 forbids | D-CC-3 |
| **Removing the hashbang from `scripts/*.mjs`** | It is the narrower fix for the `agent-imports` collection failure, but it edits seven 1F rail scripts to work around a harness gap. Slice 1 fixes the harness instead, so a future `.mjs` rail imported from a test does not reproduce the same defect | Nothing — recorded so the alternative is on the record |
| **The `agent_call` orphan sweep as a running job** | 0003 defines the sweep (rows `pending` > 10 min → `failed`, `wall_hit='none'`, `output {"reason":"orphaned"}`). Scheduling it needs a worker, which is Phase 1.5 and depends on D-7 | The `job` table plus a runner, after the pilot's core path works |
| **`rule 36` real `auditLog()` and `rule 48` notification channel** | Both are release-blocking for live send/book/pay, and neither is reachable until `agent_call` exists in a database. 0003 creates the table; the writer lands with the agent runtime, not in this ticket's slices | Slices 2 → 8, then a Group 7 ticket |
| **Approval-terms UI** | `approval.terms` + `terms_hash` are server-side in 0003. The human-facing confirmation surface is front end and this pilot is back end only | A front-end ticket after the API exists |

## Ideas raised and parked (version 2)

- **A collected-test census that also names which file lost tests.** Slice 1's floor check fails on the counts. Naming the specific file that shrank is nicer and is not needed to hold the floor.
- **A generated policy matrix rendered into the reply entries** so a reviewer reads the matrix rather than the SQL. Cosmetic until the live run exists.
