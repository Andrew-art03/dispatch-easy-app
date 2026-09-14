-- tests/schema/rls.sql -- SPEC 2B's two-account isolation proof, as invariants.
--
-- Every statement must return ZERO rows against any database this repo has migrated. Run by
-- scripts/check-schema-live.mjs against SCRATCH_DB_URL when it is present, never prod
-- (rule 49). Statements are separated by a line containing only `;;`.
--
-- READ THIS BEFORE RUNNING IT. These are DESTRUCTIVE in the sense that they insert two orgs,
-- two users and a load, and they clean up after themselves in the same transaction. They are
-- for a scratch database and nowhere else. The file never names a project ref; the runner
-- refuses the prod ref structurally before any driver is imported.
--
-- WHY IT IS SHAPED AS "SELECT SOMETHING THAT MUST BE EMPTY" RATHER THAN AS ASSERTIONS. The
-- runner is deliberately dumb -- it runs a statement and fails on any returned row -- so each
-- test returns a description of what went wrong and returns nothing when it did not. A test
-- framework that needs a framework is a test framework that does not run in CI.
--
-- Added 2026-09-14 by Claude Code, EZ-BUILD-01 Slice 3 (ticket 2B).

-- 1. FORCE, not merely ENABLE. 0001 enabled RLS and stopped there, which leaves the table
--    owner -- the role that runs migrations -- exempt from every policy. This is the single
--    fact 0004 exists to change, so it is invariant number one.
select relname || ': enabled=' || relrowsecurity || ' forced=' || relforcerowsecurity as violation
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and (not c.relrowsecurity or not c.relforcerowsecurity);
;;
-- 2. Every policy that scopes a tenant derives org from identity. A policy whose expression
--    mentions current_setting, a JWT claim or a request header is reading something the client
--    sent, which is not a tenant boundary at all -- it is a suggestion.
select tablename || '.' || policyname || ': ' || coalesce(qual, with_check, '') as violation
  from pg_policies
 where schemaname = 'public'
   and coalesce(qual, '') || coalesce(with_check, '') ilike '%current_setting%';
;;
-- 3. auth.org_id() exists, is SECURITY DEFINER, and has a pinned search_path. Without definer
--    it is blocked by the user table's own RLS and recurses; without the pinned search_path a
--    caller can shadow `public` and change what the function resolves. Both reviewers asked
--    for this explicitly in SPEC 2B v2.
select 'auth.org_id() is not security definer with a pinned search_path' as violation
 where not exists (
   select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'org_id'
      and p.prosecdef
      and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path=public, pg_temp%');
;;
-- 4. THE NAMED NEGATIVE: user A inserting a row with org_id = B is refused by `with check`.
--    Two orgs, two users, and A tries to write a load into B. The insert must raise; if it
--    succeeds, this returns the row it should never have been able to create.
do $$
declare
  org_a uuid; org_b uuid; user_a uuid := gen_random_uuid(); refused boolean := false;
begin
  insert into org (name) values ('scratch A') returning id into org_a;
  insert into org (name) values ('scratch B') returning id into org_b;
  insert into "user" (id, org_id, role) values (user_a, org_a, 'owner');
  perform set_config('request.jwt.claim.sub', user_a::text, true);
  set local role authenticated;
  begin
    insert into load (org_id) values (org_b);
  exception when insufficient_privilege or check_violation then
    refused := true;
  end;
  reset role;
  if not refused then
    raise exception 'FORGED TENANT ACCEPTED: user in org % inserted a load into org %', org_a, org_b;
  end if;
  raise notice 'forged-tenant insert refused, as it must be';
  rollback;
end $$;
;;
-- 5. THE OTHER NAMED NEGATIVE: a cross-tenant SELECT returns zero rows -- not an error, zero
--    rows. An error would tell the caller the row exists; zero rows tells them nothing.
do $$
declare
  org_a uuid; org_b uuid; user_a uuid := gen_random_uuid(); seen int;
begin
  insert into org (name) values ('scratch A') returning id into org_a;
  insert into org (name) values ('scratch B') returning id into org_b;
  insert into "user" (id, org_id, role) values (user_a, org_a, 'owner');
  insert into load (org_id) values (org_b);
  perform set_config('request.jwt.claim.sub', user_a::text, true);
  set local role authenticated;
  select count(*) into seen from load where org_id = org_b;
  reset role;
  if seen <> 0 then
    raise exception 'CROSS-TENANT READ: user in org % saw % row(s) belonging to org %', org_a, seen, org_b;
  end if;
  raise notice 'cross-tenant select returned 0 rows, as it must';
  rollback;
end $$;
;;
-- 6. O-13: a user may not insert their own user row into an org that already has users. This
--    is the hole 0001 left open -- `with check (id = auth.uid())` constrains WHICH row you
--    write and says nothing about its org_id, so any first login could join any tenant.
do $$
declare
  org_a uuid; org_b uuid; user_a uuid := gen_random_uuid(); intruder uuid := gen_random_uuid();
  refused boolean := false;
begin
  insert into org (name) values ('scratch A') returning id into org_a;
  insert into org (name) values ('scratch B') returning id into org_b;
  insert into "user" (id, org_id, role) values (user_a, org_a, 'owner');
  perform set_config('request.jwt.claim.sub', intruder::text, true);
  set local role authenticated;
  begin
    insert into "user" (id, org_id, role) values (intruder, org_a, 'owner');
  exception when insufficient_privilege or check_violation then
    refused := true;
  end;
  reset role;
  if not refused then
    raise exception 'O-13 OPEN: a new account joined populated org % by inserting its own user row', org_a;
  end if;
  raise notice 'self-insert into a populated org refused, as it must be';
  rollback;
end $$;
;;
-- 7. The audit log cannot be rewritten by anyone, service_role included (rule 36 / 0003).
select 'event is UPDATE-able or DELETE-able by ' || grantee as violation
  from information_schema.table_privileges
 where table_schema = 'public' and table_name = 'event'
   and privilege_type in ('UPDATE', 'DELETE')
   and grantee in ('authenticated', 'anon', 'service_role');
;;
-- 8. The ledger is closed to direct inserts from every role; the only writer is
--    execute_approved_action, which lands with 3A.
select 'ledger_line is INSERT-able by ' || grantee as violation
  from information_schema.table_privileges
 where table_schema = 'public' and table_name = 'ledger_line'
   and privilege_type = 'INSERT'
   and grantee in ('authenticated', 'anon', 'service_role');
