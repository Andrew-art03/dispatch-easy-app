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

**Default I proceeded under.** The placeholder ships exactly as the signed spec
writes it, with the comment intact, and a test asserts that the all-zero uid can
never satisfy `is_founder()` against a real session. Andrew substitutes the real
uid at apply time. No guess, no invented identifier.

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
