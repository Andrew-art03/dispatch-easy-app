# KNOWN_ISSUES.md

Things that are true about this build right now and are not defects to fix silently:
open findings someone has ruled on, environment facts a fresh clone needs, and anything
installed on a developer's machine that has to be removable.

Newest first.

---

## Local developer tooling installed by the build — and how to remove it

Installed 2026-09-14 by Claude Code under the D-CC-7 ruling (Director, 13:30 CT), which
authorised a local Supabase stack as "technical tooling, no cost, reversible, local only".
The ruling requires this teardown note.

| What | Version | How it was installed | Scope |
|---|---|---|---|
| Supabase CLI | **2.117.0** | `npm install -g supabase` | global npm, Andrew's user profile |
| `supabase/config.toml` + `supabase/.gitignore` | — | `supabase init --force` | this repo |
| `embedded-postgres` | **18.4.0-beta.17** | `bun add -d` | this repo (devDependency) |
| `@types/pg` | 8.23.1 | `bun add -d` | this repo (devDependency) |
| `@playwright/test` + chromium | **1.63.0** | `bun add -d` + `npx playwright install chromium` | this repo; browser binary in the user profile cache |

**Teardown — removes everything the build added, in this order:**

```bash
# 1. stop and delete the local stack's containers and volumes (only if it was ever started)
supabase stop --no-backup

# 2. remove the CLI
npm uninstall -g supabase

# 3. remove the scaffold from the repo
rm -f supabase/config.toml supabase/.gitignore

# 4. the devDependencies, if the harness is not wanted
bun remove embedded-postgres @types/pg @playwright/test

# 5. optional — the downloaded browser binaries, if you want the disk back
npx playwright uninstall --all
```

The embedded PostgreSQL keeps **no** persistent data directory: `with-test-db.ts` creates one
under the OS temp dir per run and removes it in a `finally`, so there is nothing to clean up
between runs and nothing survives a crash except an empty temp folder.

Nothing was installed system-wide, no service was registered to auto-start, and no PATH
entry was added beyond npm's existing global bin. Docker Desktop was **already installed**
on this machine; the build did not install it and must not uninstall it.

**Rule 49 is untouched.** Nothing in this build has connected to the real Supabase project,
read-only or otherwise. `.env.local` is for the local stack's keys only and is gitignored.

---

## The database harness: real PostgreSQL, no Docker

`bun run test:db` starts a throwaway PostgreSQL via the `embedded-postgres` devDependency
(`scripts/with-test-db.ts`, port **55433** — 55432 belongs to another build on this PC and
is never touched), applies the real chain 0001/0003/0004/0005/0006, runs the suite, and
tears the cluster down. No daemon, no container, no administrator.

**Docker is NOT used and is not a dependency of this build.** Docker Desktop on this machine
dies at launch because the machine-level `ProgramData` / `ALLUSERSPROFILE` variables are
empty and the fix needs an elevated shell (D-CC-8, resolved 2026-09-14 — the ruling was that
there is no Docker dependency at all). Nothing needs to be done about it for this ticket.

Two things the harness stands in for, both narrow and both asserted rather than assumed:

- **Supabase platform furniture** — the `auth` schema, `auth.users`, `auth.uid()` reading the
  request GUC, and the three roles (`scripts/test-db/supabase-prelude.sql`), plus the table
  grants Supabase's platform applies (`supabase-epilogue.sql`). Without the grants a tenancy
  test would pass for the wrong reason: carrier B would read nothing because it may read
  *nothing at all*, not because RLS refused it.
- **PostGIS** — absent from the embedded binary. Exactly two columns use it
  (`facility.geo`, `facility.dock_geo`) and no test touches either, so `geography(point,4326)`
  is substituted with `text`. The count is asserted: a third such column, or any `ST_*` call,
  throws rather than quietly running a schema that is not ours.

`supabase/config.toml` is kept for Slice 9's rehearsal against a scratch branch, and is not
used by `test:db`.

---

## C-3 — `src/lib/supabase.ts` builds an unguarded client

Open since 2026-09-08, recorded NOT CLOSED by the 1F panel, and still the single violation
`check:db-boundary` reports:

```
check:db-boundary FAIL — @supabase/supabase-js imported outside packages/config/db.ts:
  src/lib/supabase.ts
```

It is not drifting: the 1F/N-6 ratchet in `tests/db-boundary.test.ts` asserts that violation
list with `toEqual` against a baseline of exactly this one file, so a new offender turns the
suite red and fixing C-3 also turns it red until the baseline entry is deleted. `auth.tsx`
and `src/lib/session.ts` both use this client rather than `createDb()`, which is why closing
C-3 is a real piece of work and not a one-line import swap.

---

## Playwright: installed, phone-first, two projects

`@playwright/test` 1.63.0 + chromium, behind `bun run test:e2e`. `playwright.config.ts`
runs **phone (393x852) first** with desktop (1280x800) as a second project, so a layout that
only works wide cannot pass by accident. Slice 7 still owns the full project — WebKit,
isolated identities per worker, the seven TESTING-PLAN workflows; this is its start.

Not part of `bun run test`, for the same reason `test:db` is not.

---

## `bun.lock` pins eight packages to a private registry — a clean clone gets 403

Carried forward from `BUILD_DEFAULTS` §5 as a known P1, not re-diagnosed here. Eight
`@supabase/*` packages plus `@lovable.dev/vite-tanstack-config` resolve to
`europe-west4-npm.pkg.dev`. Checkouts on this PC work only because `node_modules` is already
populated. CI will die at `bun install` unless the runner holds Artifact Registry
credentials. Do not silently vendor or re-pin without a ticket.
