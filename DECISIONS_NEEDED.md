# DECISIONS_NEEDED.md — ticket EZ-BUILD-01

**Only true blockers.** If `EZ-Trucking-HQ\spec\BUILD_DEFAULTS.md` answers it, it is not
a blocker and it is not on this list. Anything I deferred by choice is in
`NOT_BUILT_YET.md` instead.

Nothing on this list stops the build. Each item names the default I proceeded
under, so the work continues and the decision can land later without a rewrite.

---

## D-CC-1 — no database this build can apply a migration to

**Raised:** 2026-09-14, Slice 2 planning · **Owner:** Andrew · **Status:** OPEN

**What is blocked.** The *live* half of Slice 2 ("migration applies forward on
the scratch DB") and the *live* half of Slice 3 ("every table shows RLS
forced"). The migration file, the invariant SQL and the static tests are not
blocked and are being written.

**Why.** Two independent gaps, both of which are deliberately somebody else's
call:

1. **No Postgres driver is installed.** `scripts/migrate.ts` imports one lazily
   and fails closed with a clear message; its header says so explicitly. Rule 30
   says no package joins this toolchain until a human has read its source. I am
   not installing `postgres`/`pg` on my own authority.
2. **`SCRATCH_DB_URL` does not exist here.** It is open item #4 in
   `DIRECTOR-HANDOVER-2026-09-13.md` §3, parked with Andrew. Rule 49 forbids
   this session touching the real Supabase project for any reason, including a
   read-only look, without a specific go-ahead for that one query — so the real
   project is not a fallback and I have not gone near it.

**What I need.** Either (a) a scratch-classified connection string plus a named
driver Andrew has read and approved, or (b) Andrew applies 0003 in the
dashboard himself and pastes the output, which is what rule 28 prefers anyway.

**Default I proceeded under.** Write 0003 in full, assert everything provable
about it without a connection (grant/revoke lines, constraint shapes, PK shape,
the security-definer bodies, parity against `schema.sql`), mark the live apply
`unverified` in the reply entry, and carry on to Slice 4. I will not report an
apply I did not watch (R-9 / rule 25).

---

## D-CC-2 — the founder auth uid in `is_founder()`

**Raised:** 2026-09-14, Slice 2 planning · **Owner:** Andrew · **Status:** OPEN,
non-blocking

SPEC §2C pins the founder to a hard-coded `auth.users.id` **and** the
`app_metadata` flag, both of which must hold. The spec ships the uid as
`00000000-0000-0000-0000-000000000000` with a comment saying Andrew fills it in
when he applies 0003.

**Default I proceeded under — as actually built in Slice 2, and stronger than the
spec.** O-3 (logged 2026-09-06) showed why a comment is not enough: applied as
written, the zeroes uid makes `is_founder()` false for every human and the
rule-37 kill switch becomes permanently unreleasable through the database — an
engaged switch nobody can release.

So `supabase/migrations/0003_hardening_and_runtime.sql` ships `{{AUTH_USERS_ID}}`,
an unsubstituted literal, and **GATE 0 is the first statement in the file**: it
raises unless the value is UUID-shaped and is not the all-zeroes uid. The
migration runs in one transaction, so it aborts whole rather than half-applying.
`tests/migration-0003.test.ts` asserts the placeholder is still unsubstituted in
git — a real uid committed here would be a live identifier in a public repo.

Andrew substitutes the real uid at apply time, from Supabase Dashboard →
Authentication → Users. No guess, no invented identifier, and no way to apply
without it.

---

## D-CC-3 — CI cannot `bun install` from a clean clone

**Raised:** 2026-09-14 (carried from BUILD_DEFAULTS §5 and handover §4b) ·
**Owner:** Andrew · **Status:** OPEN, non-blocking for local work

`bun.lock` pins eight `@supabase/*` packages plus
`@lovable.dev/vite-tanstack-config` to `europe-west4-npm.pkg.dev` (Lovable's
private registry). A clean clone gets 403. Local checkouts only work because
`node_modules` is already populated. When the `ci.yml` gate lines land, the
runner will die at `bun install` unless it holds Artifact Registry credentials.

**What I need.** A decision between: Artifact Registry credentials as an Actions
secret, or a ticket to re-point those pins at `registry.npmjs.org` and re-lock.

**Default I proceeded under.** Neither. I have not re-pinned or vendored
anything — BUILD_DEFAULTS §5 says that is a ticket, not a side effect. Every
gate this build adds is wired into `bun run test`, which is already a CI step,
so the gates become real the moment CI can install at all.

---

## D-CC-4 — every money column in the frozen schema is `numeric`, and the money path is integer cents

**Raised:** 2026-09-14, Slice 9 · **Owner:** Andrew · **Status:** OPEN, partially worked around

`ledger_line.amount`, `load.gross_rate`, `load.accessorials`, `deal.target_rate`,
`deal.floor_rate`, `deal.agreed_rate`, `score.true_net`, `score.all_in_rpm`,
`score.net_per_day`, `score.recommended_bid`, `score.floor_rate` and `call.minutes`
are all `numeric` in `supabase/schema.sql`.

Postgres `numeric` is exact decimal, so **nothing is lost inside the database**.
The problem is the trip out: PostgREST hands `numeric` to JavaScript as a
`number`, which is an IEEE-754 float — and BUILD_DEFAULTS R-4 says money is
integer cents with no float formed at any point, "including the parse". 3B's
calculator and 4A's normalizer both speak integer cents end to end. The seam is
exactly at the database boundary.

**What I did, narrowly.** Migration 0006 adds `ledger_line.amount_cents bigint`
and makes it authoritative, because the ledger is the record of what money
actually moved and it is currently empty, so the change costs nothing. `amount`
stays (the frozen schema requires it NOT NULL) as an exact-numeric display copy
derived from the integer, never the reverse.

**What I did not do, and why.** The other five tables reach the finished front
end — `score` and `deal` are read by components that are already built and
signed off. Widening a frozen schema across tables nobody asked me to touch, in
a way that changes what the front end receives, is not a builder's call.

**What I need.** A decision on whether the remaining money columns get
`*_cents` companions in their own migration, and if so whether the front end
changes in the same PR or reads both for a transition period. Until then, any
code reading those columns is reading a float, and R-4 is satisfied only on the
ledger.

---

## D-CC-5 — `src/components/AddExpense.tsx`: three findings, and the feature is already broken

**Raised:** 2026-09-14, Slice 9 · **Owner:** Andrew · **Status:** OPEN

Found by a Slice 9 test that asserts no TypeScript writes a ledger line. One
file does, and looking at it turned up three separate problems in fifteen lines.

**1. It inserts into `ledger_line` directly, with the user's JWT.** Migration
0003 revokes `insert on ledger_line` from `authenticated`, `anon` and
`service_role` — money is written by `execute_approved_action` after
`consume_approval`, and by nothing else (SPEC 2C v3, enforced at the grant
layer). **So applying 0003 stops this feature working.**

**2. It forms a float on the money path.** `const value = Number(amount)` on a
text input, then `amount: -Math.abs(value)`. That is the parse R-4 names
explicitly.

**3. It is already broken today, before any migration of mine.** The code
carries the comment *"org_id is filled by the database default
(current_org_id()) — never sent from here"* and omits `org_id`. **There is no
such default.** `ledger_line.org_id` is `not null` with no default, and no table
in the frozen schema defaults `org_id` at all. The insert violates NOT NULL, so
it cannot ever have succeeded. A test pins this so the claim is checkable rather
than asserted in a report.

**Why I did not fix it.** `src/**` is out of this ticket's scope
(BUILD_DEFAULTS §2), and the fix is a product decision rather than a mechanical
one: **expenses have no approved-action path.** `execute_approved_action`
requires an `approval` row, and requiring a human approval for every fuel
receipt may or may not be what Andrew wants. Inventing that flow would be
inventing a product.

**What I need.** One of:
- expenses go through `execute_approved_action` like every other ledger write, with an approval minted by the same tap that saves the expense; or
- expenses are a distinct class with their own server endpoint and their own rule, written down; or
- the expense feature is parked until there is an answer.

**Default I proceeded under.** The offender is recorded by name in
`tests/ledger.test.ts` — more offenders than the list is a failure, fewer means
one was fixed. Identical treatment to C-3. Nothing was changed in `src/**`.
