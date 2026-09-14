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

**Teardown — removes everything the build added, in this order:**

```bash
# 1. stop and delete the local stack's containers and volumes (only if it was ever started)
supabase stop --no-backup

# 2. remove the CLI
npm uninstall -g supabase

# 3. remove the scaffold from the repo
rm -f supabase/config.toml supabase/.gitignore

# 4. optional — the images the stack pulls, if you want the disk back
docker image prune -a --filter "label=com.supabase.cli.project"
```

Nothing was installed system-wide, no service was registered to auto-start, and no PATH
entry was added beyond npm's existing global bin. Docker Desktop was **already installed**
on this machine; the build did not install it and must not uninstall it.

**Rule 49 is untouched.** Nothing in this build has connected to the real Supabase project,
read-only or otherwise. `.env.local` is for the local stack's keys only and is gitignored.

---

## The local stack is not running yet — Docker Desktop needs one human start

See `DECISIONS_NEEDED.md` **D-CC-8**. `supabase start` fails because the Docker engine is
not up:

```
LegacyDockerLifecycleInspectError: failed to inspect container health: failed to connect
to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine
```

Docker Desktop's processes run and its WSL distro boots, but the engine pipe is never
published and `AcceptedTermsOfService` is empty — it is waiting on a first-run dialog that
only a person at the keyboard can clear. Until then Slices 1–5 cannot be verified against a
real database, and per the ruling they must not fall back to mocks for the tenancy tests.

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

## Playwright is not installed

Slices 1–4 each ask for a Playwright case and Slice 7 asks for the whole project. Nothing
Playwright-related is in `package.json` yet. It was deliberately not installed on
2026-09-14: the constraint on Slice 1 is the database, not the browser driver, and
installing a test runner that cannot yet reach a working app would have been motion rather
than progress.

---

## `bun.lock` pins eight packages to a private registry — a clean clone gets 403

Carried forward from `BUILD_DEFAULTS` §5 as a known P1, not re-diagnosed here. Eight
`@supabase/*` packages plus `@lovable.dev/vite-tanstack-config` resolve to
`europe-west4-npm.pkg.dev`. Checkouts on this PC work only because `node_modules` is already
populated. CI will die at `bun install` unless the runner holds Artifact Registry
credentials. Do not silently vendor or re-pin without a ticket.
