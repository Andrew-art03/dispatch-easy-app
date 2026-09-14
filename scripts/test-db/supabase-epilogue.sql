-- =====================================================================================
-- HARNESS ONLY -- the table privileges Supabase's platform grants, applied AFTER the
-- chain because they name tables the chain creates.
--
-- WHY THIS MATTERS MORE THAN IT LOOKS. Without these grants every query as
-- `authenticated` fails with "permission denied for table load" -- and a tenancy test
-- would then PASS for entirely the wrong reason. Carrier B would be unable to read
-- carrier A's rows because it cannot read ANY row, and the suite would report the RLS
-- boundary as proved while proving only that we forgot to grant.
--
-- That failure mode is the whole reason this file is separate and commented: the grant is
-- what makes the RLS policy the thing actually under test. On the real platform these are
-- Supabase's defaults for the `authenticated` role; here they are stated out loud.
--
-- Note the deliberate asymmetry with the real platform: no grants to `anon`. Nothing in
-- this product is readable signed-out, so an anon grant here could only ever hide a
-- policy mistake.
-- =====================================================================================

grant usage on schema public to authenticated;

grant select, insert, update, delete
  on all tables in schema public
  to authenticated;

grant usage, select on all sequences in schema public to authenticated;

-- Functions the chain declares. `auth.org_id()` and friends already carry their own
-- explicit grants in 0004; this covers anything else the chain adds later without
-- silently leaving it unreachable.
grant execute on all functions in schema public to authenticated;
