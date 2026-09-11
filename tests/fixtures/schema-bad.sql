-- Planted-bad fixture for scripts/check-schema-parity.mjs --self-test (2A, static half).
--
-- good_table is fully compliant, using BOTH RLS statement styles the real schema
-- uses or may use: it is named in the DO-block enable loop AND has a per-table
-- FORCE statement. bad_table has no org_id, is absent from the loop, and is never
-- forced. With no allowlist, the checker MUST report exactly three gaps, all on
-- bad_table, and none on good_table. If it ever reports fewer, the gate is
-- decorative and the self-test fails CI. Never deployed anywhere.

create table good_table (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  note text,
  amount numeric(12, 2) check (amount >= 0) -- nested parens: the body parser must survive these
);

create table bad_table (
  id uuid primary key default gen_random_uuid(),
  owner_ref uuid, -- looks tenant-ish but is NOT org_id; must not satisfy the invariant
  note text
);

do $$
declare t text;
begin
  foreach t in array array['good_table'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

alter table good_table force row level security;

create policy good_org on good_table for all using (org_id = current_org_id());
