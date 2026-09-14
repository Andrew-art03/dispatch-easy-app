-- =====================================================================================
-- HARNESS ONLY -- the Supabase platform pieces our migration chain assumes exist.
-- Applied by scripts/with-test-db.ts BEFORE 0001. Never applied to any real project,
-- never part of supabase/migrations/, and nothing in the app imports it.
--
-- WHY THIS FILE EXISTS. `supabase/migrations/0001_baseline.sql` opens with
-- `id uuid primary key references auth.users(id)`, and 44 policies across the chain call
-- `auth.org_id()`, which 0004 defines in terms of `auth.uid()`. All of that is platform
-- furniture that Supabase provides and a bare PostgreSQL does not. Without it the chain
-- cannot be applied at all, so the tenancy proof could not be run anywhere except against
-- a hosted project -- which rule 49 forbids.
--
-- WHAT IT IS ALLOWED TO BE. A faithful stand-in for the platform, and nothing more. It
-- must never define anything the chain itself defines (`auth.org_id()`, `current_org_id()`,
-- `org_has_no_users()` are all 0004's and stay 0004's), and it must never relax a policy.
-- If this file ever has to be edited to make a test pass, that is the test telling you the
-- migration is wrong, not the harness.
-- =====================================================================================

create schema if not exists auth;
create schema if not exists extensions;

-- ---------------------------------------------------------------------------
-- Roles. Only `authenticated` is granted anything by the chain (10 grants), but
-- `anon` and `service_role` exist on the real platform and a policy that
-- accidentally names one must fail here the same way it would there.
-- ---------------------------------------------------------------------------
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$roles$;

-- ---------------------------------------------------------------------------
-- auth.users -- the table `public."user".id` points at.
--
-- Deliberately minimal: id and email. The chain only ever uses the id as a
-- foreign-key target, so inventing the rest of GoTrue's columns would be
-- inventing facts (BUILD_DEFAULTS §6) and would let a test depend on something
-- the real platform might not match.
-- ---------------------------------------------------------------------------
create table if not exists auth.users (
  id    uuid primary key,
  email text
);

-- ---------------------------------------------------------------------------
-- auth.uid() / auth.role() / auth.jwt() -- read from the request GUC, exactly as
-- Supabase's own do, so a test sets identity the same way PostgREST does:
--
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';
--
-- `true` as the second argument to current_setting means "return null if unset"
-- rather than raising, which is what lets an unauthenticated session evaluate a
-- policy to false instead of erroring.
-- ---------------------------------------------------------------------------
create or replace function auth.jwt() returns jsonb
  language sql stable as $fn$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb
$fn$;

create or replace function auth.uid() returns uuid
  language sql stable as $fn$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$fn$;

create or replace function auth.role() returns text
  language sql stable as $fn$
  select nullif(auth.jwt() ->> 'role', '')
$fn$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
