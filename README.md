# EZ Trucking Auto Dispatching

Phone-first PWA for truck owner-operators. React + TypeScript + Tailwind + shadcn/ui on TanStack Start, with Supabase Auth and Row Level Security.

## Screens

1. Login / Sign up (`/auth`) — email + password, optional magic link. First login bootstraps one `org` and one `user` row (role `owner`).
2. Truck profile (`/truck`) — cost and preference settings with a completeness percentage.
3. Board (`/board`) — loads grouped by state with gross, true net and verdict.
4. Load card (`/loads/:id`) — verdict, money numbers, reasons, "How we calculated this", actions.
5. Hunt (`/hunt`) — paste a load or upload a screenshot, review parsed fields, save load + stops.
6. Docs camera (`/docs/:loadId`) — capture/upload documents to the `docs` bucket, list them, bundle PDF.
7. Ledger (`/ledger`) — ledger lines with weekly totals.

## Setup

Requires Node.js 20+ (or Bun).

```sh
npm install
cp .env.example .env   # fill in your Supabase URL + publishable key
npm run dev            # http://localhost:8080
```

`npm run build` produces the production build.

## Scripts

Run with `bun run <name>` (the lockfile is `bun.lock`; npm works too).

| Script | What it does |
| --- | --- |
| `dev` | Vite dev server on http://localhost:8080 |
| `build` | Production build into `.output` |
| `lint` | ESLint over the repo |
| `format` | Prettier, writing in place |
| `typecheck` | `tsc --noEmit` — types only, no emit |
| `test` | Vitest, single run (CI mode) |
| `check:env` | Fails if a service/secret/role value is committed to tracked source or a tracked `.env*` |
| `check:bundle` | Fails if a service-role credential reached `.output` — run after `build` |
| `check:agent-imports` | Walks the real import graph from every module under `agents/` and fails if any of them can reach `@supabase/supabase-js`, however many hops away |

`check:env` and `check:bundle` are the two halves of the same rail: the first catches a
secret before it is built, the second catches one that got in anyway. Both are hard
failures, not warnings (CLAUDE.md rule 6).

`check:agent-imports` is rule 40's structural half (ticket 1F, finding C-1). Every other
control for "an agent process cannot hold a production client" is a runtime control that
presupposes the agent goes through `createDb()`; this one proves there is no import path
by which it could construct a client at all. It is a dependency walk, not a grep — a
re-export defeats a grep — and it runs its own planted-positive self-test on every
invocation (`--self-test` runs only that). The same walk runs inside `bun run test` as
`tests/agent-imports.test.ts`, so it gates PRs today; the standalone script wants its own
line in `.github/workflows/ci.yml` (see *Checks CI does not run yet* below).

### Checks CI does not run yet

`.github/workflows/ci.yml` runs `lint`, `typecheck`, `check:env`, `test`, `build` and
`check:bundle`. These exist and pass locally but have no workflow line, because writing
`.github/workflows/` needs a GitHub token with the `workflow` scope, which Claude Code's
token deliberately does not have (rule 27). **Andrew:** adding each as a `- run:` line in
the `check` job is the whole change.

```yaml
      - run: bun run check:db-boundary     # red today — see finding C-1 / ticket 1F
      - run: bun run check:agent-imports
      - run: bun run check:schema
      - run: bun run check:migration-baseline
```

## Environment

| Variable | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Public browser key (anon / publishable) |
| `EZ_PROCESS_KIND` | `agent` \| `app` \| `edge`. Unset means `agent` — the web app and Edge Functions opt out explicitly, so a forgotten variable fails safe |

`EZ_PROCESS_KIND` is a **fallback, not an authority** (ticket 1F, finding C-2). Anything
under `agents/` declares the process an agent in code at import time, and a process
started from an entrypoint under `agents/` is an agent whatever it imported. Either of
those outranks the variable, and a variable that contradicts them trips the kill switch
instead of resolving — so setting `EZ_PROCESS_KIND=app` can no longer turn off rule 40's
check. Both signals are deny-only: they can assert `agent`, never `app` or `edge`.

Only public values belong in `.env`. Service-role keys and any AI provider keys live in Supabase Edge secrets — never in this codebase. `.env` is git-ignored.

## Database

The schema is frozen and already applied to the Supabase project (migrations 0001 and 0002). This app never creates, renames, or drops tables, columns, enums, or policies.

Tables used: `org`, `user`, `truck`, `load`, `stop`, `score`, `deal`, `document`, `ledger_line`. Storage bucket: `docs`, paths prefixed `{org_id}/`.

Every read relies on RLS scoped to the signed-in user's org; the client never passes `org_id` as a filter.

## Server endpoints (stubbed)

State changes never happen from the client. These routes are placeholders for the dispatch service:

- `POST /api/loads` — parse a pasted load / screenshot
- `POST /api/loads/{id}/pursue`
- `POST /api/loads/{id}/skip`
- `POST /api/loads/{id}/confirm`
- `GET /api/loads/{id}/pack.pdf`

## PWA

`public/manifest.json` plus `public/sw.js` make the app installable on iOS and Android home screens.
