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

`check:env` and `check:bundle` are the two halves of the same rail: the first catches a
secret before it is built, the second catches one that got in anyway. Both are hard
failures, not warnings (CLAUDE.md rule 6).

## Environment

| Variable | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Public browser key (anon / publishable) |

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
