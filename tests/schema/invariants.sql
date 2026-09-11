-- tests/schema/invariants.sql -- SPEC 1D schema invariants, verbatim.
-- These are INVARIANTS, not conventions: every query must return ZERO rows against
-- any database this repo has migrated. Run by scripts/check-schema-live.mjs against
-- SCRATCH_DB_URL when it is present (never prod, rule 49). Statements are separated
-- by a line containing only `;;` so the runner can split them without parsing SQL.

-- 1. Every public table has row-level security ENABLED and FORCED.
select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r' and (not relrowsecurity or not relforcerowsecurity);
;;
-- 2. Every public base table has an org_id column (rule 4: explicit tenant boundary on every record).
select table_name from information_schema.tables t where table_schema='public' and table_type='BASE TABLE' and not exists (select 1 from information_schema.columns where table_schema='public' and table_name=t.table_name and column_name='org_id');
;;
-- 3. Every public table has at least one policy that scopes by auth.org_id().
select tablename from pg_tables t where schemaname='public' and not exists (select 1 from pg_policies p where p.tablename=t.tablename and (p.qual ilike '%auth.org_id()%' or p.with_check ilike '%auth.org_id()%'));
