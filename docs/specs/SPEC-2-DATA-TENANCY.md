# SPEC — Group 2: Data, tenancy, audit (2A–2E)
Status: **v3 — SIGNED by Grok + ChatGPT (2A/2B/2E APPROVE; 2C/2D APPROVE WITH CHANGES, applied below). Perplexity/Gemini pending Andrew.** See REVIEW.md. · Author: Cowork, 2026-09-06 · Source: round-1 synthesis · Governs: CLAUDE.md rules 4, 10, 12, 25, 36, 39, 49; 02-ARCHITECTURE tenancy section.
Preconditions: Group 1 🟩. Andrew's answer on **D-6** (migration 0003) — 2C is the only subsection that needs it; 2A/2B/2D/2E proceed regardless.

---

## 2A — Schema parity (part of EZ-002)
**Purpose.** What is deployed == `HQ/schema.sql`, always, checked by a machine.
**Touches.** `scripts/schema-diff.ts`; `supabase/schema.snapshot.sql` (committed).
**Interface.** `pnpm schema:diff` → dumps scratch schema (`pg_dump --schema-only --no-owner`), normalises whitespace/comments, diffs against `schema.snapshot.sql`; non-zero exit on any difference. Also asserts, via SQL:
```sql
select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and relkind='r' and not relrowsecurity;      -- must be empty
select table_name from information_schema.tables t where table_schema='public'
  and not exists (select 1 from information_schema.columns where table_name=t.table_name and column_name='org_id'); -- must be empty
```
**Tests.** CI runs it after migrations. Negative: add a column in a test migration → red.
**Top failure mode.** Drift between HQ's schema and reality (already happened once — trackers vs code). Prevented by CI.
**A/B/C.** A: automated diff. B: the two SQL assertions only. C: manual `\d` review per release.
**Done when.** Snapshot committed; CI job green; the two assertion queries return zero rows.

## 2B — RLS proof: two-account isolation (part of EZ-002; Day-2 item 7)
**Purpose.** Tenant is derived from identity, never from the request.
**Touches.** A SQL function + every policy; `tests/integration/rls.test.ts`; storage policies on `docs`.
**Interface.**
```sql
create unique index if not exists user_auth_user_id_uq on public."user"(auth_user_id);
create or replace function auth.org_id() returns uuid
  language sql stable security definer
  set search_path = public, pg_temp                       -- v2: fixed search_path (both reviewers)
as $$ select u.org_id from public."user" u where u.auth_user_id = auth.uid() $$;
-- owner = postgres (bypasses RLS by ownership). Returns NULL when no user row → every policy below is false.
-- The user table's OWN policy must key only off auth.uid() — never auth.org_id() — or it recurses:
create policy user_self on public."user" using (auth_user_id = auth.uid()) with check (auth_user_id = auth.uid());
-- policy shape for every other table (example: load)
create policy load_tenant on load using (org_id = auth.org_id()) with check (org_id = auth.org_id());
alter table load force row level security;               -- v2: owners covered too (every table)
-- storage: first path segment must be the caller's org — cross-org paths impossible by construction
create policy docs_tenant on storage.objects for all using (bucket_id = 'docs' and (storage.foldername(name))[1] = auth.org_id()::text);
```
Existing 0001 policies are reviewed against this shape. If 0001 keys off a JWT claim instead: **finding to Andrew (D-6)**, and the migration path is dual-write — the access-token hook emits the claim so both agree, then policies move to `auth.org_id()` in a labelled PR. Never a silent swap.
```ts
// tests/integration/rls.test.ts — matrix, generated
for (const table of TABLES) for (const op of ['select','insert','update','delete']) {
  it(`${table}.${op}: A cannot touch B`, ...)   // expect 0 rows / permission error, never data
}
it('forged org_id in insert body is rejected', ...)
it('anon sees nothing', ...)
it('storage: B cannot download A path, cannot sign A path', ...)
it('service role bypasses RLS (documented, tested, so nobody is surprised)', ...)
```
**Tests.** The matrix above (15 tables × 4 ops + 4 specials), run as the table **owner** and as `service_role` too so nobody is surprised by what bypasses. Negative that matters: user A inserts a row with `org_id = B` → refused by `with check`. Recursion test: `select * from "user"` as a user completes in < 50 ms with the plan showing one index lookup.
**Top failure mode.** A policy trusts a client-controlled value. Prevented by the function + the forged-insert test.
**A/B/C.** A: generated matrix in CI. B: hand-written tests for load/truck/document only. C: manual two-account walkthrough recorded in EVIDENCE once.
**Done when.** Matrix green on scratch; output pasted to EVIDENCE; Day-2 item 7 ticked in WHERE-WE-ARE.

## 2C — Migration 0003 (EZ-092 + new; needs D-6) — **rewritten after review**
**Purpose.** Everything the freeze cannot do without, in **one** human-run migration, written so that 0004 is not needed within a month.
**Touches.** `supabase/migrations/0003_hardening_and_runtime.sql`.
**Interface.**
```sql
-- 0. founder = platform-level, not per-org. v3 (Grok): app_metadata is writable with the service role, so the founder is
--    pinned to a hard-coded auth uid AND the flag — both must hold. Andrew supplies the uid when he applies 0003.
create or replace function is_founder() returns boolean language sql stable as
  $$ select auth.uid() = '00000000-0000-0000-0000-000000000000'::uuid /* <-- Andrew's auth.users.id, filled in by Andrew */
        and coalesce((auth.jwt() -> 'app_metadata' ->> 'ez_founder')::boolean, false) $$;

-- 1. EZ-092 hardening
create trigger user_org_immutable before update of org_id on "user" for each row execute function raise_immutable();
revoke update, delete on event from authenticated, anon, service_role;                   -- insert-only audit
-- v2 (Grok): machine columns are written ONLY by security-definer functions
revoke update (status, exception) on load from authenticated, anon;                      -- transition_load() only (3A)
revoke update, delete on score from authenticated, anon;                                 -- insert-only, calculator path only
revoke update, delete on ledger_line from authenticated, anon;                           -- insert-only
alter table "user" force row level security;  -- and every other table: force RLS so owners are covered

-- 2. idempotency
create table idempotency (org_id uuid not null references org(id), operation text not null, key text not null,
  request_hash text not null, response jsonb check (octet_length(response::text) <= 65536), created_at timestamptz not null default now(),  -- v3: byte-size check
  primary key (org_id, operation, key));
create index on idempotency (created_at);                                                 -- purge after 7 days

-- 3. agent audit (rule 36)
create table agent_call (id uuid primary key default gen_random_uuid(), org_id uuid not null references org(id),
  load_id uuid references load(id), correlation_id uuid not null, skill text not null, provider text not null, model text not null,
  status text not null default 'pending' check (status in ('pending','done','failed')),   -- v2: row exists BEFORE the call
  input jsonb not null, params jsonb, output jsonb, wall_hit text check (wall_hit in ('schema','authority','action','none')),
  tokens_in int, tokens_out int, cost_cents int, latency_ms int, created_at timestamptz not null default now(), finished_at timestamptz);
revoke update, delete on agent_call from authenticated, anon, service_role;             -- nobody updates rows directly
-- v3 (Grok): the pending→done/failed write goes through one security-definer function that can touch ONLY these columns
create or replace function finish_agent_call(p_id uuid, p_status text, p_output jsonb, p_wall_hit text, p_tokens_in int, p_tokens_out int, p_cost_cents int, p_latency_ms int)
  returns void language sql security definer set search_path = public, pg_temp as $$
  update agent_call set status = p_status, output = p_output, wall_hit = p_wall_hit, tokens_in = p_tokens_in, tokens_out = p_tokens_out,
         cost_cents = p_cost_cents, latency_ms = p_latency_ms, finished_at = now()
   where id = p_id and status = 'pending' $$;                                           -- single transition, never re-finalized
create index on agent_call (org_id, created_at);
-- v3 (ChatGPT) fail path: if the process dies between the pending insert and finish_agent_call, the row stays 'pending' —
-- a scheduled sweep marks rows pending > 10 min as 'failed' with wall_hit='none' and output {"reason":"orphaned"}, so nothing is silent.

-- 4. kill switch, budgets, history (rules 37/31/43/44)
create table system_flag (key text primary key, value jsonb not null, updated_by uuid, updated_at timestamptz not null default now());
insert into system_flag values ('kill_switch', '{"engaged":false}'), ('budget', '{"tokens_per_org_day":200000,"usd_cents_per_org_day":500,"steps_per_session":50,"wallclock_s":600}');
create table system_flag_event (id bigserial primary key, key text not null, old jsonb, new jsonb, actor uuid, reason text not null,
  correlation_id uuid, at timestamptz not null default now());                           -- v2: append-only incident timeline
revoke update, delete on system_flag_event from authenticated, anon, service_role;
create policy flag_read on system_flag for select using (auth.role() = 'authenticated');
create policy flag_write on system_flag for update using (is_founder()) with check (is_founder());
-- trigger: every system_flag update inserts a system_flag_event (reason required via set_config('ez.reason'))
create table budget_use (org_id uuid not null references org(id), day date not null, tokens bigint not null default 0,
  usd_cents int not null default 0, steps int not null default 0, primary key (org_id, day));                 -- v2: cap is a flag, use is a ledger

-- 5. approvals (human gate, terms-bound)
create table approval (id uuid primary key default gen_random_uuid(), org_id uuid not null references org(id), actor_user_id uuid not null,
  action text not null check (action in ('send','book','pay','confirm')), resource_id uuid not null,
  terms jsonb not null, terms_hash text not null,                                        -- v2: canonical snapshot stored beside its hash
  created_at timestamptz not null default now(), expires_at timestamptz not null, consumed_at timestamptz);
-- v2: the ONLY way to consume — atomic, single-use, tenant-scoped
create or replace function consume_approval(p_id uuid, p_action text, p_resource uuid, p_terms_hash text) returns approval
  language sql security definer set search_path = public, pg_temp as $$
  update approval set consumed_at = now()
   where id = p_id and org_id = auth.org_id() and action = p_action and resource_id = p_resource
     and terms_hash = p_terms_hash and consumed_at is null and expires_at > now()
  returning * $$;   -- zero rows = refuse (expired, drifted terms, already used, wrong tenant)

-- 6. money atomicity (ChatGPT)
alter table ledger_line add column source_ref text not null default '';                  -- v3 (ChatGPT): NOT NULL
create unique index ledger_line_business_key on ledger_line (org_id, load_id, kind, source_ref);
-- execute_approved_action(p_approval uuid, …): consume_approval → insert ledger_line → transition_load, one transaction (body in 3A/6E).
-- v3 (ChatGPT): enforced at the grant layer, not by convention — insert on ledger_line and execute on consume_approval/transition_load
-- are REVOKED from authenticated/anon/service_role; only execute_approved_action (security definer) may call them:
revoke insert on ledger_line from authenticated, anon, service_role;
revoke execute on function consume_approval(uuid,text,uuid,text) from public, authenticated, anon, service_role;
grant execute on function execute_approved_action(uuid, jsonb) to authenticated;         -- the ONE production money/action path

-- 7. plan entitlement
alter table org add column plan text not null default 'pilot_free', add column trial_ends_at timestamptz;

-- 8. parent/child tenant consistency
create trigger stop_org_matches_load before insert or update on stop for each row execute function assert_child_org('load');
create trigger deal_org_matches_load before insert or update on deal for each row execute function assert_child_org('load');
create trigger document_org_matches_load before insert or update on document for each row execute function assert_child_org('load');

-- 9. Phase-1.5 worker (only if D-7 = yes; otherwise this block moves to 0004)
create table job (id uuid primary key default gen_random_uuid(), org_id uuid not null references org(id), kind text not null,
  payload jsonb not null, status text not null default 'queued' check (status in ('queued','running','done','failed')),
  attempts int not null default 0, run_after timestamptz not null default now(), locked_at timestamptz, last_error text,
  created_at timestamptz not null default now());
create index on job (status, run_after);

-- RLS + force on every new table via auth.org_id(); system_flag/system_flag_event per policies above.
```
**Tests.** Integration: `update "user" set org_id=…` fails; `update event` fails even as service role; `update load set status=…` as authenticated fails; duplicate idempotency key fails; `stop`/`deal`/`document` with mismatched org fails; two concurrent `consume_approval` calls → exactly one row; `consume_approval` with a drifted `terms_hash` → zero rows; `system_flag` update by a non-founder fails, by founder succeeds and writes a `system_flag_event`; RLS matrix (2B) extended to every new table.
**Top failure mode.** Migration written by an agent and applied to prod by reflex. Prevented: Andrew runs it in the dashboard after reading it (rule 28); the repo wrapper refuses prod (1D).
**A/B/C.** A: all of the above in 0003. B: 0003 = §1–§6, 0004 = §7–§9. C: §1 only; `agent_call` falls back to typed `event` payloads (documented as not meeting rule 36 — release still blocked).
**Done when.** Applied to scratch by Andrew or CI; 2A parity passes with the new snapshot; tests green; Andrew's written yes on D-6 (and D-7 for §9) in `handoff/`.

## 2D — Request context + capabilities (new ticket)
**Purpose.** Every Edge Function gets `{requestId, orgId, userId, role}` from one middleware; "authenticated" ≠ "allowed".
**Touches.** `supabase/functions/_shared/context.ts`, `_shared/authz.ts`.
**Interface.**
```ts
export interface RequestContext { requestId: string; authUserId: string; orgId: OrgId; userId: UserId; role: 'owner'|'dispatcher'|'driver' }
export async function withContext(req: Request, handler: (ctx: RequestContext, body: unknown) => Promise<Response>): Promise<Response>
// verifies JWT with the anon client (never service role), loads user row, refuses if no user row (403), attaches x-request-id
export type Capability = 'load.read'|'load.create'|'load.transition'|'deal.approve'|'document.upload'|'document.read'|'call.confirm'|'ledger.write'|'admin.kill_switch';
export const ROLE_CAPS: Record<RequestContext['role'], readonly Capability[]> = {...};
export function requireCapability(ctx: RequestContext, cap: Capability): void  // throws 403
```
Rule: `createDb('privileged')` (1B) is imported by exactly the functions listed in the repo CLAUDE.md (`documents` signing, `agent_call` writer, `system_flag` founder endpoint); a lint rule + CI grep enforce the list.
**Technical invariant (v2, ChatGPT):** agents cannot write state directly — not as a convention but structurally: (a) agent processes' secret manifests (1C) contain no service key; (b) `createDb('privileged')` refuses when `isAgentProcess` (1B); (c) machine columns are revoked from `authenticated` (2C) so even a user-JWT-bearing agent cannot `UPDATE load.status`; (d) agents reach the database only through `/skill` (which writes `agent_call`) and the security-definer functions `transition_load` / `consume_approval` / `execute_approved_action`, every one of which requires a server-made Approval for anything binding. Test: an agent-kind process attempting each of (a)–(d) fails, and the failure is itself an `agent_call` row with `wall_hit='action'`.
**Tests.** Valid JWT → ctx; expired → 401; JWT with no user row → 403; driver calling `admin.kill_switch` → 403; founder check uses `is_founder()` (app_metadata), not `user.role`; **negative:** body `{org_id: B}` under user A is ignored — ctx.orgId is A.
**Top failure mode.** Authorization copied into every handler and drifting. Prevented by the single wrapper.
**A/B/C.** A as above. B: wrapper only, role check per handler. C: owner-only mutations for the pilot.
**Done when.** All functions use `withContext`; grep shows the privileged client in the allowed files only.

## 2E — Idempotency on every mutating endpoint (new ticket)
**Purpose.** Retries on a bad cell signal or a double-tap never duplicate a load, an approval, a ledger line.
**Touches.** `_shared/idempotent.ts`; every `POST/PUT`; `idempotency` table (2C — until then, an in-function unique-key insert on `event` is the fallback).
**Interface.**
```ts
export async function idempotent<T>(ctx: RequestContext, operation: string, key: string, body: unknown, run: () => Promise<T>): Promise<T>
// v2: opens ONE transaction; inserts (org_id, operation, key, request_hash) → on conflict: hash matches → stored response (200), else 409;
// v3 (ChatGPT): uniqueness + replay are DB-enforced — the PK is the contract; replay reads the stored `response` row, never re-runs the handler.
// the handler runs inside that same transaction, so idempotency → authz → transition → ledger → response is one commit.
// request_hash = sha256(canonical JSON: sorted keys, body minus Idempotency-Key / timestamps / trace headers). Stored response ≤ 64 KB. Rows purged after 7 days.
```
Client sends `Idempotency-Key: <ulid>` (generated once per user action, kept across retries). **Gate (Grok): no money or intake endpoint ships on the `event` fallback — 2E depends on 0003.**
**Tests.** Same request twice → one row, same response; two concurrent identical → one row; same key + different body → 409. Negative: missing header on a mutating endpoint → 400 (not silently allowed).
**Top failure mode.** Double "Take it" while the truck's on the shoulder with one bar. Prevented server-side, not by disabling a button.
**A/B/C.** A: table-backed. B: unique constraint on `event(org_id, correlation_id)`. C: client-side ULID + server duplicate detection within a 60-s window.
**Done when.** All mutating functions wrapped; tests green.

---
## Sign-off
Grok + ChatGPT signed v2 with the four changes above (finish_agent_call, pinned founder uid, grant-layer enforcement of the money path + source_ref NOT NULL, byte-size cap + DB-enforced replay, orphaned-row sweep). v3 = signed.
