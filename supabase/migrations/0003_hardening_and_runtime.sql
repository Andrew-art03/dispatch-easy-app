-- =====================================================================================
-- 0003_hardening_and_runtime.sql  --  EZ-BUILD-01 Slice 2 (ticket 2C)
-- =====================================================================================
-- Source of truth: reviews/backend/2-data-tenancy/SPEC.md section 2C (v3, SIGNED Grok+ChatGPT).
-- Predecessor: reviews/backend/2-data-tenancy/0003_hardening_and_runtime.DRAFT.sql (skeleton,
-- 2026-09-06). This is that skeleton finished: its five named TODOs are closed below and four
-- further migration-aborting defects, found by reading the FROZEN schema instead of the spec's
-- prose, are fixed. Every difference from SPEC 2C is labelled inline with an O-number.
--
-- TEMPLATE, NOT A RUNNABLE FILE. {{AUTH_USERS_ID}} is an unsubstituted placeholder and GATE 0
-- refuses to run while it still is one. Substitute, read, then apply -- in that order.
--
-- APPLY ORDER, non-negotiable: scratch DB first -> invariants + RLS matrix green -> Andrew
-- applies to the real project by hand, having read it. No agent applies this, ever
-- (CLAUDE.md rules 28, 40, 49). It runs in ONE transaction, so it aborts whole or not at all.
--
-- =====================================================================================
-- THE OBJECTIONS THIS FILE CLOSES
-- =====================================================================================
-- O-1  execute_approved_action() was GRANTED in 0003 while its body was deferred to 3A/6E.
--      "function does not exist" -> the whole migration rolls back. CLOSED by option (ii) of
--      the draft's own O-8 decision point: the function AND its grant are not in 0003 at all.
--      They land in the migration that defines transition_load(). That is not a new decision --
--      it is the slice order this build was dispatched with (transition_load is Slice 6 / 3A,
--      the ledger money path is Slice 9 / 6E), so 0003's blast radius stays equal to its own
--      section and nothing can reach the money path before 3A exists. Option (iii), a stubbed
--      call, stays rejected: rule 33 forbids a later step running before its prerequisite has
--      returned a real result, and a half-wired money path is worse than an absent one.
--
-- O-2  raise_immutable() and assert_child_org() were attached by triggers but defined nowhere.
--      Same abort. CLOSED: both are defined in SECTION A, which runs before any trigger or
--      grant references them. Ordering through the file is helpers -> tables -> functions ->
--      grants -> triggers -> RLS, and nothing is ever referenced before it exists.
--
-- O-3  is_founder() shipped with the all-zeroes uid, which returns false for every human and
--      leaves the rule-37 kill switch permanently unreleasable through the database. CLOSED:
--      GATE 0 is the first statement in the file and raises unless {{AUTH_USERS_ID}} has been
--      replaced by something UUID-shaped that is not the all-zeroes uid. It cannot ship silently.
--
-- O-9   NEW, and it would have aborted the migration. SPEC 2C section 1 revokes
--       `update (status, exception) on load`. The frozen schema has NEITHER column: load's
--       state column is `state` (type load_state) and there is no `exception` column anywhere
--       in schema.sql. Verified by reading supabase/schema.sql, not by trusting the prose.
--       CLOSED: the revoke names `state`. `exception` is NOT invented here -- the schema is
--       frozen and a new column is a ticket, not a side effect. See the TODO in SECTION D.
--
-- O-10  NEW, same class. SPEC 2C section 6 builds the ledger business key on
--       `ledger_line (org_id, load_id, kind, source_ref)`. There is no `kind` column; it is
--       `category`. CLOSED: the unique index uses `category`.
--
-- O-11  NEW. The draft's assert_child_org() did `execute format('select ($1).%I', ...) using new`.
--       Postgres cannot infer a type for $1 there. CLOSED: the parent key is read with
--       to_jsonb(new) ->> ..., which needs no type inference and no dynamic record access.
--
-- O-12  NEW. Every revoke in SECTION D names authenticated / anon / service_role, and
--       is_founder() calls auth.uid(). On a database without the Supabase roles or the auth
--       schema each of those aborts with an error that reads like a typo. CLOSED: GATE 1 names
--       the missing prerequisite instead, and fails closed.
--
-- =====================================================================================
-- WHAT IS DELIBERATELY NOT HERE
-- =====================================================================================
--   * execute_approved_action() and its grant -- O-1 above, lands with transition_load().
--   * auth.org_id(). SPEC section 2B's deliverable, not 2C's. The deployed schema already has
--     current_org_id() -- security definer, reads the user row, exactly 2B's shape under a
--     different name -- so the policies below key off it and 2B moves ALL policies (0001's 19
--     and this file's) to auth.org_id() in one labelled migration. SPEC 2B's own words: "never
--     a silent swap."
--   * FORCE ROW LEVEL SECURITY on the 15 pre-existing tables. 2B's deliverable (Slice 3), where
--     it lands together with the policy matrix that proves it. The SEVEN tables created here are
--     forced here, because shipping a new table unforced would be the defect 2B exists to fix.
--   * Any schedule. purge_idempotency() and sweep_orphaned_agent_calls() are defined; wiring
--     them to a timer needs the 6F worker and is recorded in NOT_BUILT_YET.md.
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- GATE 0 -- refuse to run while the founder uid is still a placeholder   (O-3)
-- Deliberately the first statement. One transaction, so this aborts everything rather
-- than half-applying it.
-- -------------------------------------------------------------------------------------
do $gate0$
begin
  if '{{AUTH_USERS_ID}}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'REFUSING TO APPLY 0003: {{AUTH_USERS_ID}} has not been substituted with a real auth.users.id. Applying with a placeholder would make is_founder() false for every account and leave the rule-37 kill switch permanently unreleasable. Supabase Dashboard -> Authentication -> Users.';
  end if;
  if '{{AUTH_USERS_ID}}' = '00000000-0000-0000-0000-000000000000' then
    raise exception 'REFUSING TO APPLY 0003: the all-zeroes UUID is not a real account.';
  end if;
end
$gate0$;


-- -------------------------------------------------------------------------------------
-- GATE 1 -- the prerequisites every later statement assumes                    (O-12)
-- Without these, SECTION D aborts on "role does not exist" and is_founder() aborts on
-- "schema auth does not exist" -- both of which read like typos rather than like a
-- migration pointed at the wrong kind of database.
-- -------------------------------------------------------------------------------------
do $gate1$
declare
  missing text[] := '{}';
  r text;
begin
  foreach r in array array['authenticated', 'anon', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      missing := missing || r;
    end if;
  end loop;
  if array_length(missing, 1) is not null then
    raise exception 'REFUSING TO APPLY 0003: missing Supabase role(s): %. Every revoke in this migration names them, and a database without them is not the database this migration is for.', array_to_string(missing, ', ');
  end if;

  if to_regprocedure('auth.uid()') is null then
    raise exception 'REFUSING TO APPLY 0003: auth.uid() does not exist. is_founder() and every policy below depend on it.';
  end if;

  if to_regprocedure('public.current_org_id()') is null then
    raise exception 'REFUSING TO APPLY 0003: current_org_id() does not exist. Apply 0001_baseline.sql first -- every policy in SECTION F keys off it.';
  end if;
end
$gate1$;


-- -------------------------------------------------------------------------------------
-- SECTION A -- helper functions FIRST, so later triggers and grants can reference them
--              (O-1 / O-2)
-- -------------------------------------------------------------------------------------

-- A1. Generic immutability guard. Used by the user.org_id trigger in SECTION E.
create or replace function raise_immutable() returns trigger
  language plpgsql as $fn$
begin
  raise exception 'column is immutable on %.% (attempted change blocked)',
    tg_table_schema, tg_table_name;
end
$fn$;

-- A2. Parent/child tenant consistency (SPEC 2C section 8). Trigger arg 0 is the parent
--     table; the child's FK is <parent>_id, which holds for all three children in the
--     frozen schema: stop.load_id, deal.load_id, document.load_id (read, not assumed).
--
--     O-11: the parent key is read through to_jsonb(new), because
--     `execute format('select ($1).%I', ...) using new` leaves Postgres with no type to
--     infer for $1.
--
--     Invoker rights ON PURPOSE, not an oversight. Under RLS a parent row belonging to
--     another org is invisible to this caller, so parent_org comes back null and the row
--     is refused. A row you cannot see is a row you cannot attach a child to.
create or replace function assert_child_org() returns trigger
  language plpgsql as $fn$
declare
  parent_table text := tg_argv[0];
  parent_org   uuid;
  child_parent uuid;
begin
  child_parent := (to_jsonb(new) ->> (parent_table || '_id'))::uuid;
  if child_parent is null then
    return new;                                    -- no parent row to disagree with
  end if;
  execute format('select org_id from %I where id = $1', parent_table)
    into parent_org using child_parent;
  if parent_org is null or parent_org <> new.org_id then
    raise exception 'org mismatch: %.org_id=% does not match %.org_id=%',
      tg_table_name, new.org_id, parent_table, parent_org;
  end if;
  return new;
end
$fn$;

-- A3. Founder identity. The hard-coded uid AND the app_metadata flag must BOTH hold,
--     because app_metadata is writable with the service role (Grok, SPEC v3).
create or replace function is_founder() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $fn$
  select auth.uid() = '{{AUTH_USERS_ID}}'::uuid
     and coalesce((auth.jwt() -> 'app_metadata' ->> 'ez_founder')::boolean, false)
$fn$;

-- A4. The system_flag audit trigger (draft SECTION E TODO, closed here).
--     Rule 37: every engage/release writes a loud, separate incidents record. A reason is
--     REQUIRED and is passed as `select set_config('ez.reason', '...', true)` in the same
--     transaction -- an un-narrated flip of the kill switch is refused outright.
--     Security definer so the row lands even though SECTION D revokes insert on
--     system_flag_event from every role: the trigger is the only writer there is.
create or replace function log_system_flag_change() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  reason text := nullif(trim(coalesce(current_setting('ez.reason', true), '')), '');
begin
  if reason is null then
    raise exception 'system_flag.% cannot change without a reason. Set it in the same transaction: select set_config(''ez.reason'', ''why'', true);', new.key;
  end if;
  insert into system_flag_event (key, old, new, actor, reason, correlation_id)
  values (
    new.key,
    old.value,
    new.value,
    auth.uid(),
    reason,
    nullif(trim(coalesce(current_setting('ez.correlation_id', true), '')), '')::uuid
  );
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end
$fn$;


-- -------------------------------------------------------------------------------------
-- SECTION B -- tables. No grants here; grants are SECTION D, after every function exists.
-- -------------------------------------------------------------------------------------

-- B1. Idempotency (SPEC 2C section 2). The PK is the contract: uniqueness and replay are
--     enforced by the database, not by handler code remembering to check.
create table idempotency (
  org_id       uuid not null references org(id) on delete cascade,
  operation    text not null,
  key          text not null,
  request_hash text not null,
  response     jsonb check (octet_length(response::text) <= 65536),
  created_at   timestamptz not null default now(),
  primary key (org_id, operation, key)
);
create index idempotency_created_at_idx on idempotency (created_at);   -- purged after 7 days

-- B2. Agent audit -- the rule-36 replayable record (SPEC 2C section 3).
--     The row is written BEFORE the model call, at status 'pending', so a call that dies
--     mid-flight still leaves a trace. Nothing but finish_agent_call() moves it off pending.
create table agent_call (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  load_id uuid references load(id) on delete set null,
  correlation_id uuid not null,
  skill text not null,
  provider text not null,
  model text not null,
  status text not null default 'pending' check (status in ('pending','done','failed')),
  input jsonb not null,
  params jsonb,
  output jsonb,
  wall_hit text check (wall_hit in ('schema','authority','action','none')),
  tokens_in int, tokens_out int, cost_cents int, latency_ms int,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index agent_call_org_created_idx on agent_call (org_id, created_at);
create index agent_call_pending_idx on agent_call (status, created_at) where status = 'pending';

-- B3. Kill switch, budgets, incident timeline (SPEC 2C section 4; rules 31/37/43/44).
--     system_flag and system_flag_event are PLATFORM-level, not per-org, and so carry no
--     org_id. That is the exception CLAUDE.md rule 4 anticipates in its own parenthesis, and
--     it is recorded in supabase/schema.allowlist.0003.json with its reason rather than left
--     for a reader to infer.
create table system_flag (
  key text primary key,
  value jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create table system_flag_event (
  id bigserial primary key,
  key text not null,
  old jsonb, new jsonb,
  actor uuid,
  reason text not null,
  correlation_id uuid,
  at timestamptz not null default now()
);
create table budget_use (
  org_id uuid not null references org(id) on delete cascade,
  day date not null,
  tokens bigint not null default 0,
  usd_cents int not null default 0,
  steps int not null default 0,
  primary key (org_id, day)
);
insert into system_flag (key, value) values
  ('kill_switch', '{"engaged":false}'),
  ('budget', '{"tokens_per_org_day":200000,"usd_cents_per_org_day":500,"steps_per_session":50,"wallclock_s":600}');

-- B4. Approvals (SPEC 2C section 5). terms is the canonical snapshot stored beside its hash,
--     so "what was approved" is readable later and not merely hashed.
create table approval (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  actor_user_id uuid not null references "user"(id),
  action text not null check (action in ('send','book','pay','confirm')),
  resource_id uuid not null,
  terms jsonb not null,
  terms_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index approval_org_resource_idx on approval (org_id, resource_id, action);

-- B5. Phase-1.5 worker queue. D-7 = yes, confirmed by Andrew in handoff 2026-09-06 14:22 CT.
create table job (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  kind text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index job_status_run_after_idx on job (status, run_after);

-- B6. Columns on existing tables (SPEC 2C sections 6/7).
--
--     The draft left source_ref as an OPEN QUESTION: SPEC says NOT NULL, but `default ''`
--     satisfies NOT NULL on existing rows while making the business key collide for every
--     two rows that both mean "no source" -- which is the opposite of what a business key is
--     for. Settled here the only way that does not lose information: add nullable, backfill
--     each existing row with a value unique to that row and visibly synthetic, then enforce
--     NOT NULL and DROP the default so no future writer can fall into '' by omission.
alter table ledger_line add column source_ref text;
update ledger_line set source_ref = 'legacy:' || id::text where source_ref is null;
alter table ledger_line alter column source_ref set not null;
-- O-10: the frozen schema's column is `category`, not `kind` as SPEC 2C section 6 writes it.
create unique index ledger_line_business_key on ledger_line (org_id, load_id, category, source_ref);

alter table org add column plan_tier text not null default 'pilot_free',
                add column trial_ends_at timestamptz;
-- NOTE, not a defect: the frozen schema already has org.plan ('standard' | 'auto'), which is
-- the equipment/automation tier and means something else entirely. SPEC 2C section 7 asks for
-- a billing entitlement; adding it as `plan` would have aborted on a duplicate column and, had
-- it not, would have silently overloaded a live column with a second meaning. It is plan_tier.
-- Slice 11 reads plan_tier and nothing else. No price, no copy, no Stripe -- D-2 is Andrew's.


-- -------------------------------------------------------------------------------------
-- SECTION C -- security-definer functions, defined BEFORE SECTION D grants them   (O-1)
-- -------------------------------------------------------------------------------------

-- C1. The only way an agent_call row leaves 'pending' (SPEC 2C section 3, v3).
--     `and status = 'pending'` is the single-transition guard: a finished row can never be
--     re-finalized, so the audit record cannot be rewritten after the fact.
create or replace function finish_agent_call(
  p_id uuid, p_status text, p_output jsonb, p_wall_hit text,
  p_tokens_in int, p_tokens_out int, p_cost_cents int, p_latency_ms int)
  returns void language sql security definer set search_path = public, pg_temp as $fn$
  update agent_call
     set status = p_status, output = p_output, wall_hit = p_wall_hit,
         tokens_in = p_tokens_in, tokens_out = p_tokens_out,
         cost_cents = p_cost_cents, latency_ms = p_latency_ms, finished_at = now()
   where id = p_id and status = 'pending'
$fn$;

-- C2. Atomic, single-use, tenant-scoped approval consume (SPEC 2C section 5, v2).
--     Zero rows returned = refuse. Expired, drifted terms, already used, wrong tenant -- the
--     caller cannot tell which, and does not need to.
create or replace function consume_approval(
  p_id uuid, p_action text, p_resource uuid, p_terms_hash text)
  returns approval language sql security definer set search_path = public, pg_temp as $fn$
  update approval set consumed_at = now()
   where id = p_id and org_id = current_org_id() and action = p_action
     and resource_id = p_resource and terms_hash = p_terms_hash
     and consumed_at is null and expires_at > now()
  returning *
$fn$;

-- C3. The orphan sweep (SPEC 2C section 3, ChatGPT v3). If a process dies between the pending
--     insert and finish_agent_call, the row would sit at 'pending' forever and the audit trail
--     would quietly have a hole in it. This closes it as 'failed', never as 'done'.
--     Defined, not scheduled -- see NOT_BUILT_YET.md.
create or replace function sweep_orphaned_agent_calls(p_older_than interval default interval '10 minutes')
  returns integer language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  n integer;
begin
  update agent_call
     set status = 'failed', wall_hit = 'none',
         output = jsonb_build_object('reason', 'orphaned'), finished_at = now()
   where status = 'pending' and created_at < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end
$fn$;

-- C4. Idempotency purge (SPEC 2C section 2: "rows purged after 7 days"). Defined, not scheduled.
create or replace function purge_idempotency(p_older_than interval default interval '7 days')
  returns integer language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  n integer;
begin
  delete from idempotency where created_at < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end
$fn$;

-- NOT DEFINED HERE: execute_approved_action(uuid, jsonb). O-1 / draft O-8 option (ii). It calls
-- transition_load(), which is section 3A's deliverable, and it lands in that migration together
-- with its grant. Until then there is no production money path at all, which is the intended
-- state: rule 36 blocks live send/book/pay while auditLog() is still a stub anyway.


-- -------------------------------------------------------------------------------------
-- SECTION D -- grants and revokes LAST, once every referenced function exists   (O-1)
-- Machine columns are written ONLY by security-definer functions. Enforced at the grant
-- layer, not by convention (SPEC v3, ChatGPT).
-- -------------------------------------------------------------------------------------

-- The audit log is insert-only for everyone, service_role included (rule 36).
revoke update, delete on event from authenticated, anon, service_role;

-- O-9: the frozen schema's column is `state`, not `status`, and there is no `exception`
-- column at all. SPEC 2C section 1 names both; revoking a column that does not exist aborts
-- the migration. `state` moves only through transition_load() (3A / Slice 6).
-- TODO(3A): load.exception does not exist in the frozen schema. If the state machine needs
-- it, it arrives as its own migration with Andrew's review -- a frozen schema is not widened
-- as a side effect of a hardening pass.
revoke update (state) on load from authenticated, anon;

revoke update, delete on score from authenticated, anon;          -- insert-only, calculator path
revoke update, delete on ledger_line from authenticated, anon;    -- insert-only
revoke insert on ledger_line from authenticated, anon, service_role;  -- execute_approved_action only

revoke update, delete on agent_call from authenticated, anon, service_role;  -- finish_agent_call only

-- The incident timeline is written by its trigger and by nothing else, in any role.
revoke insert, update, delete on system_flag_event from authenticated, anon, service_role;
-- Flag keys are fixed. A flag is flipped, never added or removed.
revoke insert, delete on system_flag from authenticated, anon, service_role;

-- SPEC 2C section 5 calls consume_approval "the ONLY way to consume". Stated as prose it is a
-- convention; revoking direct UPDATE is what makes it true. Same reasoning ChatGPT's v3 applied
-- to ledger_line, applied to the row that authorises the money rather than records it.
revoke update, delete on approval from authenticated, anon, service_role;

-- Budgets are a control (rules 31/43/44). A tenant that can edit its own usage row can spend
-- past its own ceiling; the runtime writes these through the privileged client.
revoke insert, update, delete on budget_use from authenticated, anon;

-- The queue is the worker's. A tenant may watch its own jobs and may not manufacture them.
revoke insert, update, delete on job from authenticated, anon;

-- Nobody calls consume_approval directly; execute_approved_action (3A / Slice 6) will be the
-- only caller, and it is security definer.
revoke execute on function consume_approval(uuid, text, uuid, text)
  from public, authenticated, anon, service_role;
revoke execute on function finish_agent_call(uuid, text, jsonb, text, int, int, int, int)
  from public, authenticated, anon;
revoke execute on function sweep_orphaned_agent_calls(interval) from public, authenticated, anon;
revoke execute on function purge_idempotency(interval) from public, authenticated, anon;
revoke execute on function raise_immutable() from public, authenticated, anon, service_role;
revoke execute on function assert_child_org() from public, authenticated, anon, service_role;
revoke execute on function log_system_flag_change() from public, authenticated, anon, service_role;
grant execute on function is_founder() to authenticated;

-- NOT GRANTED HERE: execute on execute_approved_action(uuid, jsonb) -- O-1. The grant lands in
-- the same migration as the function, or it aborts this one.


-- -------------------------------------------------------------------------------------
-- SECTION E -- triggers (SECTION A helpers now exist)
-- -------------------------------------------------------------------------------------
create trigger user_org_immutable        before update of org_id on "user"
  for each row execute function raise_immutable();
create trigger stop_org_matches_load     before insert or update on stop
  for each row execute function assert_child_org('load');
create trigger deal_org_matches_load     before insert or update on deal
  for each row execute function assert_child_org('load');
create trigger document_org_matches_load before insert or update on document
  for each row execute function assert_child_org('load');
-- Draft SECTION E TODO, closed: every system_flag change writes its incident row, and a
-- change with no stated reason is refused (rule 37).
create trigger system_flag_audited before update on system_flag
  for each row execute function log_system_flag_change();


-- -------------------------------------------------------------------------------------
-- SECTION F -- RLS on the seven tables this migration creates.
-- Draft SECTION F TODO, closed. Enabled AND forced, so the table owner is covered too.
--
-- Policies key off current_org_id(), the security-definer function 0001 already deployed --
-- same shape as SPEC 2B's auth.org_id(), different name. 2B (Slice 3) moves every policy in
-- the database, these included, to auth.org_id() in one labelled migration. Writing new
-- policies against a function that does not exist yet would abort; writing them against a
-- JWT claim would be the exact failure mode 2B exists to prevent.
-- -------------------------------------------------------------------------------------
do $rls$
declare t text;
begin
  foreach t in array array['idempotency','agent_call','system_flag','system_flag_event','budget_use','approval','job'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end
$rls$;

-- Tenant-scoped tables. `for all` with both using and with check, so a row can never be
-- written into another org even by a caller who can see its own (SPEC 2B's forged-tenant case).
create policy idempotency_org on idempotency for all
  using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy budget_use_org on budget_use for select
  using (org_id = current_org_id());
create policy approval_org on approval for all
  using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy job_org on job for select
  using (org_id = current_org_id());

-- Read-only to the tenant. agent_call rows are written by the /skill endpoint through the
-- privileged client and finalized by finish_agent_call(); an org may read its own audit and
-- may not author it.
create policy agent_call_org_read on agent_call for select
  using (org_id = current_org_id());

-- Platform-level. Every authenticated user must be able to SEE that the kill switch is
-- engaged -- that is the point of it -- and only the founder may flip it (SPEC 2C section 4).
create policy flag_read on system_flag for select
  using (auth.role() = 'authenticated');
create policy flag_write on system_flag for update
  using (is_founder()) with check (is_founder());

-- The incident timeline is the founder's. It carries no tenant data and is written only by
-- the trigger above.
create policy flag_event_read on system_flag_event for select
  using (is_founder());


-- =====================================================================================
-- END. What a reviewer should check, in order:
--   1. GATE 0 still holds a placeholder in git. If it holds a real uid, that is a leak.
--   2. Nothing is granted or triggered before SECTION A/C define it.
--   3. Every column named here exists in supabase/schema.sql. O-9 and O-10 are what happens
--      when that is assumed instead of read.
--   4. The seven new tables are enabled AND forced, and every one has a policy.
-- tests/migration-0003.test.ts asserts 1-4 mechanically so a later edit cannot quietly undo them.
-- =====================================================================================
