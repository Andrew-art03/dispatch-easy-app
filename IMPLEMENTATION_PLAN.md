# IMPLEMENTATION_PLAN.md — ticket EZ-BUILD-01 (back-end pilot)

**Builder:** Claude Code · **Opened:** 2026-09-14 · **Repo:** `dispatch-easy-app`
**Binding document:** `EZ-Trucking-HQ\spec\BUILD_DEFAULTS.md`. Where it and a spec differ, it wins.
**Reply file:** `EZ-Trucking-HQ\handoff\CODE-TO-COWORK.md` (append, one entry per slice).

This file is the builder's plan. It is an input to `BUILD-PLAN.md`, never a competing tracker.

---

## 0. What was true when this plan was written

Read off the repo and the remote on 2026-09-14, not inferred from any summary.

| Fact | Evidence |
|---|---|
| `origin/main` = `19e79085aa7abd22f088c20da47159cf4729fff4` | `git ls-remote origin main`, after this session pushed it. It was `0481a76` for a week. |
| Local `main` is level with the remote | `git rev-list --left-right --count origin/main...HEAD` → `0 0` |
| The suite collects 12 files / 268 tests when healthy | `bun run test`; today 11 files pass, 252 tests, **`tests/agent-imports.test.ts` collects 0** |
| 15 tables in the frozen schema | `org, user, truck, driver, facility, broker, load, stop, deal, document, score, event, hunt, call, ledger_line` — `supabase/schema.sql` |
| Only migration on disk is `0001_baseline.sql` | `ls supabase/migrations` |
| No Postgres driver is installed | `scripts/migrate.ts` header: `apply()` fails closed, by design, pending a human reading the driver's source (rule 30) |
| `tsconfig.json` `include` already covers `packages/**`, `agents/**`, `tests/**` | read directly — BUILD_DEFAULTS R-1 is satisfied on this tree and must stay that way |

### The agent-imports failure, diagnosed

`DIRECTOR-HANDOVER-2026-09-13.md` §5 recorded `tests/agent-imports.test.ts`
collecting 0 tests with `SyntaxError: Invalid or unexpected token`, and proposed
that the merge had changed the environment the file is parsed in.

**It is not the merge.** Measured here:

- `git diff e58d336 19e7908 -- package.json tsconfig.json vite.config.ts bunfig.toml bun.lock eslint.config.js` → **empty**. The merge changed no config file at all.
- A four-line probe test whose only content is `import { checkAgentImports } from "../scripts/assert-agent-imports.mjs"` reproduces the identical error. The test file's own body is irrelevant.
- `scripts/assert-agent-imports.mjs` line 1 is `#!/usr/bin/env node`, and is that on `e58d336` too (`git show e58d336:scripts/...`).
- `node -e "import('./scripts/assert-agent-imports.mjs')"` → loads fine. Node strips a hashbang; Vite's transform pipeline does not apply to `.mjs`, so the `#` reaches V8 and is an invalid token.

So: the gate has been importable-only-by-node since it was written, and the
suite's green run on `ez-010` predates whatever `node_modules` state now exists.
The merge exposed it; it did not cause it. **The fix is in the harness, not in
the test file and not in the gate script** — Slice 1.

---

## 1. Slice-by-slice plan

Every slice: branch off `origin/main`, one PR, no merge by the builder, four
commands pasted verbatim plus the slice's rails, reply entry appended.

### Slice 1 — land the foundation, prove the gate is live
**Branch** `ez-build-01-slice-1`
**Files**
- `vitest.config.ts` *(new)* — first vitest config in the repo; `passWithNoTests: false`, explicit `include` covering `tests/**` and `agents/**`, and a hashbang-stripping transform so a `.mjs` rail script is importable from a test.
- `scripts/assert-test-floor.mjs` *(new)* — reads vitest's JSON report and fails when collected **files** < 12 or **tests** < 268, or when any collected file contributes 0 tests. Carries its own `--self-test`.
- `package.json` — `test` script runs the suite and then the floor check.
- `.gitignore` — the JSON report path.

**Where I expect trouble.** A `vitest.config.ts` supersedes `vite.config.ts`
entirely rather than merging with it, so the lovable/TanStack plugin chain
leaves the test environment. No test imports `@/` or real `src/**` (checked by
grep), so this should be inert — but the proof is the file/test count, and if it
moves at all the config goes back and the fix becomes narrow instead.

**Done when.** `bun run test` prints ≥ 12 files / ≥ 268 tests with
`agent-imports` collecting its 16; an emptied test file makes the suite red
(shown, then reverted); `check:agent-imports` and `check:db-boundary` self-test
red on a planted positive.

### Slice 2 — 2C migration 0003
**Branch** `ez-build-01-slice-2`
**Files**
- `supabase/migrations/0003_hardening_and_runtime.sql` *(new)* — from `reviews/backend/2-data-tenancy/0003_hardening_and_runtime.DRAFT.sql` + SPEC §2C v3.
- `supabase/schema.sql` + `supabase/schema.allowlist.json` — parity for the new tables.
- `tests/schema/invariants.sql` — the SQL assertions 2C names.
- `tests/migration-0003.test.ts` *(new)* — static assertions over the migration text (the grant/revoke lines, the `check` constraints, the PK shape), which are provable without a database.

Tables: `agent_call`, `idempotency`, `system_flag`, `system_flag_event`,
`budget_use`, `approval`, `job`. `event` insert-only with update/delete revoked
from `authenticated`, `anon` **and** `service_role`. `agent_call` rows written
**before** the model call at `status='pending'`, finalized only through
security-definer `finish_agent_call`, with the orphan sweep for rows pending
> 10 min. Idempotency PK `(org_id, operation, key)` + `request_hash`, response
capped at 64 KB, purged after 7 days. Parent/child org triggers on `stop`,
`deal`, `document`. O-1/O-2/O-3 closed in the reply entry.

**Where I expect trouble — and it is a real one.** "Applies forward on the
scratch DB" cannot be executed by me: no Postgres driver is installed (rule 30
says a human reads its source first) and `SCRATCH_DB_URL` is still parked with
Andrew (handover §3 item 4). The migration, the invariant SQL and the static
tests all land; the live apply is recorded in `DECISIONS_NEEDED.md` as D-CC-1
and `NOT_BUILT_YET.md`, and I do not claim an apply I did not watch (R-9).
The founder `auth.uid()` in `is_founder()` stays the all-zero placeholder the
spec ships with — Andrew fills it when he applies.

### Slice 3 — 2B RLS proof
**Branch** `ez-build-01-slice-3`
**Files** `supabase/migrations/0004_force_rls.sql` *(new, if 0003 does not already carry every table)*, `supabase/schema.allowlist.json` (the 15 `force_rls` waivers come out), `tests/rls-matrix.test.ts` *(new)*, `tests/schema/rls.sql` *(new)*.
15 tables × 4 ops + the named negatives: A inserting `org_id = B` refused by
`with check`; a forged `org_id` in an insert body rejected; a cross-tenant
select returning **zero rows**, asserted as an explicit deny with the mismatch
named in an audit row.
**Trouble.** Same database gap as Slice 2. The matrix is generated and its SQL
is asserted statically; the live two-account run is D-CC-1's dependant.

### Slice 4 — 2D request context
**Branch** `ez-build-01-slice-4`
**Files** `supabase/functions/_shared/context.ts`, `_shared/authz.ts`, `tests/request-context.test.ts` — all new.
`withContext` verifies the JWT with the **anon** client, never the service role;
loads the user row; 403 when absent. `RequestContext { requestId, authUserId,
orgId, userId, role }` plus `Capability` / `ROLE_CAPS` / `requireCapability`.
Named test: body `{org_id: B}` under user A is ignored and `ctx.orgId` is A
(R-6). `createDb('privileged')` refuses when `isAgentProcess`.
**Trouble.** Deno-flavoured Edge code inside a Vite/vitest project. The plan is
to put the logic in plain TypeScript with injected dependencies so it is
testable under vitest, and to hold the Deno-specific entry as a thin shell.

### Slice 5 — 2E idempotency
**Branch** `ez-build-01-slice-5`
**Files** `supabase/functions/_shared/idempotent.ts`, `tests/idempotency.test.ts`.
`Idempotency-Key: <ulid>`; same key + different body → 409; missing header on a
mutating endpoint → 400, never silently allowed; `request_hash =
sha256(canonical JSON: sorted keys, minus `Idempotency-Key`/timestamps/trace
headers)`; a replay reads the stored response and **never re-runs the handler**,
proved with a side-effect counter.

### Slice 6 — 3A `transition_load()`
**Branch** `ez-build-01-slice-6`
**Files** `supabase/migrations/0005_transition_load.sql`, `packages/domain/loadStateMachine.ts` (pure), `tests/transition-load.test.ts`.
Lock, verify the transition is legal, update, insert the event — one
transaction. No generic state PATCH endpoint anywhere. An illegal transition is
refused; a concurrent double-transition produces one event, not two.

### Slice 7 — 4A normalizer onto `main`
**Branch** `ez-build-01-slice-7`
**Files** brought from `ez-4a-normalizer` @ `14d805f`: `packages/domain/normalize/**`, its fixtures and tests.
Verified against SPEC-4A **v2**: the `NormalizeLoadResult` union, the denylist
(R-5), `unmapped[]` + `moneyParseIncomplete`, `ProposedMoney` with `origin` and
**no `verified_by`**, integer-cents parse with no float formed (R-4), the
ordered-stops rule, the dedupeHash algorithm. Seven injection/buried-clause
fixtures as named tests; `$2,800` linehaul plus an unparsed "Detention $75/hr
after 2 hours" sets `moneyParseIncomplete === true`; `"$2.85/mi"` does not
become a flat rate. Confirm `check:agent-imports` covers 4A's code.
**Trouble.** That branch is 68 behind and sits on `ez-3b-truenet`; it also
carries an untracked `pnpm-lock.yaml` that must not come across (BUILD_DEFAULTS
§3). Expect a manual port rather than a merge, and `packages/domain` purity
(`scripts/assert-domain-purity.mjs`) has to arrive with it.

### Slice 8 — 6A loads API
`POST /loads`, `GET /loads/:id`, `GET /loads/:id/economics`. No generic state
PATCH. Uses Slice 4's context and Slice 7's normalization. Cross-tenant read
returns zero rows; economics reads `PRE_RUN` only (R-7).

### Slice 9 — 6E ledger + week endpoints
Append-only ledger, Week-$ endpoints, leak detector. `insert on ledger_line`
revoked from `authenticated`/`anon`/`service_role`; writes go through
`execute_approved_action` after `consume_approval`. A direct insert attempt
fails; the approved path succeeds once and is single-use.

### Slice 10 — 12A vertical slice
One load, pasted rate-con to settled, end to end, with the final number
re-derivable from provenance.

### Slice 11 — money / payment, LAST
Entitlement flag and Stripe scaffolding, **placeholders only**. No prices, no
pricing copy, no live keys. The paywall switches on by config without touching
a feature. Then stop — D-2 is Andrew's.

---

## 2. Standing rules I am holding myself to

1. **The test gate is a floor.** ≥ 12 collected files, ≥ 268 tests, and a file that collects zero is a failure (R-2). Fewer files than the previous slice is a failure even if everything reported passes.
2. **Every rail gets a planted positive that is seen to fail first.** That rule found three defects in 1F and it found the diagnosis above.
3. **Verify against the real artifact** (R-9). Pasted command output or it did not happen. Re-read before overwriting.
4. **`bun` only.** No `pnpm-lock.yaml`, no `package-lock.json`, ever.
5. **Missing key → deterministic mock adapter → continue.** Never wait for a key.
6. **Blocked is not stopped.** A `TODO:` plus a reasonable default, and the item in `DECISIONS_NEEDED.md` only if it is truly blocking.
7. **Not mine to decide:** money, legal, launch timing, go/no-go, and the merge button.
8. **Not in this ticket:** 3C, 5A, 12B (unsigned specs, R-8), Part 3, and `src/**` except where a slice names a file.

## 3. Known P1 carried forward, not caused here

`bun.lock` pins eight `@supabase/*` packages and
`@lovable.dev/vite-tanstack-config` to Lovable's private registry
(`europe-west4-npm.pkg.dev`). A clean clone gets **403**; this checkout only
runs because `node_modules` is already populated. **CI will die at
`bun install`** unless the runner holds Artifact Registry credentials. Flagged,
not silently re-pinned — re-pinning is a ticket, not a side effect
(BUILD_DEFAULTS §5).
