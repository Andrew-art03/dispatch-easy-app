-- =====================================================================================
-- 0004_rls_force_and_org_id.sql  --  EZ-BUILD-01 Slice 3 (ticket 2B)
-- =====================================================================================
-- Source of truth: reviews/backend/2-data-tenancy/SPEC.md section 2B (v3, SIGNED Grok+ChatGPT).
-- Runs after 0003. TEMPLATE-FREE: no placeholder, nothing for a human to substitute.
--
-- THIS MIGRATION DROPS AND RECREATES EVERY POLICY IN public. That is deliberate and it is
-- what SPEC 2B asks for -- "policies move to auth.org_id() in a labelled PR. Never a silent
-- swap." It therefore trips 1D's RLS_DANGER guard in scripts/migrate.ts (the pattern matches
-- DROP POLICY) and CANNOT be applied without EZ_RLS_CHANGE_APPROVED set explicitly. That is
-- the guard working as designed, not an obstacle to route around: a migration that rewrites
-- every tenant boundary in the database should require someone to say so out loud.
--
-- WHAT THIS CLOSES
--
--   1. FORCE ROW LEVEL SECURITY on all 15 tables from the frozen schema. 0001 only ENABLED it,
--      which leaves the table owner exempt -- so the boundary held for users and not for the
--      role that runs migrations. The seven tables 0003 created were already forced.
--
--   2. auth.org_id(), SPEC 2B's named function, with `set search_path = public, pg_temp` (both
--      reviewers). 0001 shipped current_org_id() -- the same shape under a different name, and
--      with a search_path missing pg_temp. current_org_id() is kept and now DELEGATES, so
--      there is exactly one implementation and any caller of either name gets the same answer.
--
--   3. O-13, NEW AND IT IS A REAL HOLE. 0001's `user_self_row` policy is
--          for all using (id = auth.uid()) with check (id = auth.uid())
--      which constrains WHICH row you may write and says nothing about its org_id. A user
--      whose row does not exist yet -- every first login -- could therefore insert their own
--      user row with org_id set to somebody else's org and be inside that tenant, legitimately,
--      from then on. 0003's user_org_immutable trigger does not help: it guards UPDATE, and
--      this is an INSERT. Closed below: a self-insert is allowed only into an org that has no
--      users yet, which is exactly the first-login bootstrap and nothing else. Joining an
--      existing org needs an invitation, which does not exist yet and is in NOT_BUILT_YET.md.
--
--   4. Invariant 3 in tests/schema/invariants.sql ("every public table has a policy that
--      scopes by auth.org_id()") could never have passed, because no policy in the database
--      mentioned auth.org_id() at all. It can pass from here.
--
-- WHAT THIS DELIBERATELY DOES NOT CLOSE
--
--   * `org_bootstrap_insert ... with check (true)` still lets any authenticated user create an
--     org row with any contents. It is how sign-up works today and narrowing it changes the
--     sign-up flow, which is a product decision and not a builder's. Named in NOT_BUILT_YET.md
--     with a proposed shape rather than changed quietly.
--   * The storage policy on the `docs` bucket. SPEC 2B specifies it; storage.objects is not in
--     this repo's migration chain and the bucket does not exist yet. NOT_BUILT_YET.md.
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- GATE -- the same prerequisites 0003 checks, because 0004 can be applied on its own.
-- -------------------------------------------------------------------------------------
do $gate$
begin
  if to_regprocedure('auth.uid()') is null then
    raise exception 'REFUSING TO APPLY 0004: auth.uid() does not exist. Every policy below depends on it.';
  end if;
  if to_regprocedure('public.current_org_id()') is null then
    raise exception 'REFUSING TO APPLY 0004: current_org_id() does not exist. Apply 0001_baseline.sql first.';
  end if;
  if to_regclass('public.agent_call') is null then
    raise exception 'REFUSING TO APPLY 0004: 0003 has not been applied. 0004 forces RLS on tables 0003 creates.';
  end if;
end
$gate$;


-- -------------------------------------------------------------------------------------
-- SECTION A -- one tenant function, two names
-- -------------------------------------------------------------------------------------

-- A1. SPEC 2B's function, verbatim in shape. Security definer so the lookup is not itself
--     blocked by the "user" table's RLS, which is what would otherwise recurse. Returns NULL
--     when there is no user row, and every policy below is then false rather than permissive.
--
--     Note on the frozen schema, read rather than assumed: SPEC 2B writes
--     `select u.org_id from public."user" u where u.auth_user_id = auth.uid()` and asks for a
--     unique index on user.auth_user_id. There is no auth_user_id column. The schema makes
--     user.id itself the auth uid -- `id uuid primary key references auth.users(id)` -- so the
--     lookup is on the primary key and the requested unique index already exists as that PK.
create or replace function auth.org_id() returns uuid
  language sql stable security definer set search_path = public, pg_temp as $fn$
  select u.org_id from public."user" u where u.id = auth.uid()
$fn$;
revoke all on function auth.org_id() from public;
grant execute on function auth.org_id() to authenticated;

-- A2. The 0001 name now delegates, so there is one implementation and not two that can drift.
create or replace function current_org_id() returns uuid
  language sql stable security definer set search_path = public, pg_temp as $fn$
  select auth.org_id()
$fn$;

-- A3. O-13's helper. Security definer, so asking "does this org have any users?" from inside a
--     policy on "user" does not re-enter that policy and recurse.
create or replace function org_has_no_users(p_org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $fn$
  select not exists (select 1 from public."user" u where u.org_id = p_org)
$fn$;
revoke all on function org_has_no_users(uuid) from public;
grant execute on function org_has_no_users(uuid) to authenticated;


-- -------------------------------------------------------------------------------------
-- SECTION B -- FORCE row level security on every table in the chain.
-- ENABLE was already true for all 22; FORCE is what covers the table owner as well, and it
-- is the half 0001 left out.
-- -------------------------------------------------------------------------------------
do $force$
declare t text;
begin
  foreach t in array array[
    -- the 15 from the frozen schema
    'org','user','truck','driver','facility','broker','load','stop','deal','document',
    'score','event','hunt','call','ledger_line',
    -- the 7 from 0003, already forced there; repeated so this file is the single answer to
    -- "which tables are forced?" and re-running it is a no-op rather than a gap
    'idempotency','agent_call','system_flag','system_flag_event','budget_use','approval','job'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end
$force$;


-- -------------------------------------------------------------------------------------
-- SECTION C -- every policy, dropped and recreated against auth.org_id().
-- The shape is SPEC 2B's: `using (org_id = auth.org_id()) with check (org_id = auth.org_id())`.
-- with check is written explicitly everywhere rather than inherited from using, because an
-- inherited one is invisible in pg_policies and a reviewer cannot check what is not written.
-- -------------------------------------------------------------------------------------

-- C1. org -- the tenant itself; its own id is the boundary.
drop policy if exists org_self on org;
create policy org_self on org for all
  using (id = auth.org_id()) with check (id = auth.org_id());
-- Unchanged and deliberately so: see the header. Sign-up creates the org before the user row
-- exists, so auth.org_id() is still NULL at this point and nothing narrower can be written
-- without also deciding what sign-up looks like.
drop policy if exists org_bootstrap_insert on org;
create policy org_bootstrap_insert on org for insert to authenticated with check (true);

-- C2. user -- O-13. Keyed only off auth.uid(), never auth.org_id(), or it recurses (SPEC 2B).
drop policy if exists user_self_org on "user";
create policy user_self_org on "user" for select
  using (org_id = auth.org_id());
drop policy if exists user_self_row on "user";
create policy user_self_row on "user" for select
  using (id = auth.uid());
create policy user_self_update on "user" for update
  using (id = auth.uid()) with check (id = auth.uid());
-- The fix: your own row, into an org that has no users yet. That is the first-login bootstrap
-- and nothing else. Inserting yourself into a populated org is refused by `with check`.
create policy user_bootstrap_insert on "user" for insert
  with check (id = auth.uid() and org_has_no_users(org_id));

-- C3. Straightforward tenant tables: one `<table>_org` policy each, same shape for all eleven.
--     0001 named ledger_line's policy `ledger_org`, not `ledger_line_org`; it is dropped by
--     its real name first, or it would survive this migration still calling the old function.
drop policy if exists ledger_org on ledger_line;
do $policies$
declare t text;
begin
  foreach t in array array['truck','driver','load','stop','deal','document','score','event','hunt','call','ledger_line'] loop
    execute format('drop policy if exists %I on %I', t || '_org', t);
    execute format(
      'create policy %I on %I for all using (org_id = auth.org_id()) with check (org_id = auth.org_id())',
      t || '_org', t);
  end loop;
end
$policies$;

-- C4. facility and broker -- shared records (org_id is null) stay readable by everyone, which
--     is what the frozen schema means by a verified pin and a shared broker record. A write
--     still has to be yours: `org_id = auth.org_id()` with no null branch.
drop policy if exists facility_org_or_shared on facility;
drop policy if exists facility_org_write on facility;
drop policy if exists facility_org_update on facility;
create policy facility_org_or_shared on facility for select
  using (org_id is null or org_id = auth.org_id());
create policy facility_org_write on facility for insert
  with check (org_id = auth.org_id());
create policy facility_org_update on facility for update
  using (org_id = auth.org_id()) with check (org_id = auth.org_id());

drop policy if exists broker_org_or_shared on broker;
drop policy if exists broker_org_write on broker;
drop policy if exists broker_org_update on broker;
create policy broker_org_or_shared on broker for select
  using (org_id is null or org_id = auth.org_id());
create policy broker_org_write on broker for insert
  with check (org_id = auth.org_id());
create policy broker_org_update on broker for update
  using (org_id = auth.org_id()) with check (org_id = auth.org_id());

-- C5. 0003's tenant tables, moved off current_org_id() for the same reason as the rest.
drop policy if exists idempotency_org on idempotency;
create policy idempotency_org on idempotency for all
  using (org_id = auth.org_id()) with check (org_id = auth.org_id());
drop policy if exists approval_org on approval;
create policy approval_org on approval for all
  using (org_id = auth.org_id()) with check (org_id = auth.org_id());
drop policy if exists budget_use_org on budget_use;
create policy budget_use_org on budget_use for select
  using (org_id = auth.org_id());
drop policy if exists job_org on job;
create policy job_org on job for select
  using (org_id = auth.org_id());
drop policy if exists agent_call_org_read on agent_call;
create policy agent_call_org_read on agent_call for select
  using (org_id = auth.org_id());

-- C6. 0003's security-definer function follows the same move.
create or replace function consume_approval(
  p_id uuid, p_action text, p_resource uuid, p_terms_hash text)
  returns approval language sql security definer set search_path = public, pg_temp as $fn$
  update approval set consumed_at = now()
   where id = p_id and org_id = auth.org_id() and action = p_action
     and resource_id = p_resource and terms_hash = p_terms_hash
     and consumed_at is null and expires_at > now()
  returning *
$fn$;
revoke execute on function consume_approval(uuid, text, uuid, text)
  from public, authenticated, anon, service_role;

-- C7. Platform-level tables keep their is_founder() policies from 0003. They carry no org_id
--     and there is no tenant for them to scope to; the exemption is recorded, with its reason,
--     in supabase/schema.allowlist.0003.json and in invariant 3's own exclusion list.


-- =====================================================================================
-- END. The matrix this produces is asserted by scripts/assert-rls-matrix.mjs and
-- tests/rls-matrix.test.ts, and the live negatives are in tests/schema/rls.sql.
-- =====================================================================================
