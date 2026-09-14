-- EZ Trucking Auto Dispatching — FROZEN Day-0 schema (v0.1, 2026-09-02)
-- Supabase Postgres. Every table has org_id + RLS. No tool may add tables or columns without a ticket.
-- Run in the Supabase SQL editor (or: supabase db push). Requires: postgis (enable in Dashboard → Extensions).

create extension if not exists postgis with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- enums ----------
create type user_role as enum ('owner','dispatcher','driver');
create type equipment_type as enum ('van','reefer','flatbed','stepdeck','hotshot','box','other');
create type load_state as enum (
  'candidate_found','qualified','pursue_approved','negotiating','terms_proposed',
  'rate_con_received','booked','in_transit','delivered','billing_ready','paid_reconciled','learned','rejected');
create type stop_type as enum ('pickup','delivery');
create type load_source as enum ('manual','paste','screenshot','email','api');
create type document_type as enum ('rate_con','bol','pod','fuel_receipt','lumper_receipt','scale_ticket','inspection','other');
create type verdict as enum ('take','negotiate','skip');
create type broker_grade as enum ('green','yellow','red');
create type event_actor as enum ('human','voice','system','agent');

-- ---------- core ----------
create table org (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mc_number text, dot_number text,
  authority_status text,
  plan text not null default 'standard',           -- standard | auto
  created_at timestamptz not null default now()
);

create table "user" (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null references org(id) on delete cascade,
  role user_role not null default 'owner',
  full_name text, phone text,
  created_at timestamptz not null default now()
);

create table truck (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  unit_number text not null,
  equipment equipment_type not null default 'van',
  length_ft numeric, height_ft numeric, weight_lb integer, axles integer,
  hazmat boolean not null default false,
  mpg_loaded numeric not null default 6.5, mpg_empty numeric not null default 7.5,
  fuel_discount_per_gal numeric not null default 0,
  maintenance_reserve_per_mile numeric not null default 0.12,
  tire_reserve_per_mile numeric not null default 0.04,
  overhead_per_day numeric not null default 150,
  driver_pay_type text not null default 'none',    -- none | percent | per_mile
  driver_pay_value numeric not null default 0,
  cpm_target numeric,                              -- driver's cost per mile (Grok: CPM + 20% = target)
  min_all_in_rpm numeric, min_net_per_day numeric,
  home_base_lat double precision, home_base_lng double precision,
  max_deadhead_miles integer not null default 150,
  banned_states text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (org_id, unit_number)
);

create table driver (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  user_id uuid references "user"(id),
  truck_id uuid references truck(id),
  name text not null, phone text,
  home_by timestamptz,                             -- current home-time constraint
  available_at timestamptz, available_lat double precision, available_lng double precision,
  available_city text, hos_hours_left numeric,     -- manual until ELD linked
  created_at timestamptz not null default now()
);

create table facility (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references org(id) on delete cascade, -- null = shared/verified pin
  name text, address text not null,
  geo geography(point,4326),                       -- street address point
  dock_geo geography(point,4326),                  -- the actual shipping door
  notes text, photo_path text,
  verified_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table broker (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references org(id) on delete cascade, -- null = shared record
  name text not null, mc_number text, email_domain text, phone text,
  grade broker_grade, grade_reasons text[] not null default '{}',
  days_to_pay integer, bond_ok boolean, authority_ok boolean,
  blacklisted boolean not null default false,
  graded_at timestamptz,
  created_at timestamptz not null default now()
);

create table load (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  truck_id uuid references truck(id),
  driver_id uuid references driver(id),
  broker_id uuid references broker(id),
  state load_state not null default 'candidate_found',
  source load_source not null default 'manual',
  raw_payload jsonb,                               -- original text/screenshot extraction, never executed
  reference text, equipment equipment_type,
  gross_rate numeric, accessorials numeric not null default 0,
  loaded_miles numeric, deadhead_miles numeric, reposition_miles numeric,
  miles_source text,                               -- here | manual | google
  weight_lb integer, commodity text,
  pickup_at timestamptz, deliver_by timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on load (org_id, state);

create table stop (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  load_id uuid not null references load(id) on delete cascade,
  seq integer not null, type stop_type not null,
  facility_id uuid references facility(id),
  address text not null, city text, state text,
  window_start timestamptz, window_end timestamptz, fcfs boolean not null default false,
  contact_name text, contact_phone text, reference text,
  arrived_at timestamptz, departed_at timestamptz,  -- detention clock
  unique (load_id, seq)
);

create table deal (                                -- what the rate con must match
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  load_id uuid not null unique references load(id) on delete cascade,
  target_rate numeric, floor_rate numeric, agreed_rate numeric,
  stops_count integer,
  detention_free_hours numeric, detention_rate_per_hour numeric, detention_claim_hours integer,
  lumper_terms text, tonu numeric, payment_terms text, quick_pay_fee_pct numeric,
  script text,                                     -- non-binding negotiation brief
  created_at timestamptz not null default now()
);

create table document (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  load_id uuid references load(id) on delete cascade,
  type document_type not null,
  storage_path text not null,                      -- bucket path prefixed by org_id/
  extracted jsonb,                                 -- schema-validated, data not instructions
  confidence jsonb,                                -- per-field 0..1
  discrepancies jsonb,                             -- rate-con promise match output
  verified_by uuid references "user"(id), verified_at timestamptz,
  sender_domain text,
  created_at timestamptz not null default now()
);

create table score (                               -- one row per calculator run (economics)
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  load_id uuid not null references load(id) on delete cascade,
  calc_version text not null,
  inputs jsonb not null, outputs jsonb not null,   -- TrueNetInput / TrueNetResult
  verdict verdict not null,
  true_net numeric, all_in_rpm numeric, net_per_day numeric, recommended_bid numeric, floor_rate numeric,
  reasons text[] not null default '{}',
  fit_pass boolean, market_flag text,              -- FPM: fit hard-fail, market hot/dead note
  created_at timestamptz not null default now()
);

create table event (                               -- the audit log; every state change writes one
  id bigserial primary key,
  org_id uuid not null references org(id) on delete cascade,
  load_id uuid references load(id) on delete cascade,
  type text not null,                              -- e.g. state.booked, confirm.human, detention.arrived
  actor event_actor not null,
  actor_user_id uuid references "user"(id),
  payload jsonb,
  at timestamptz not null default now()
);
create index on event (org_id, load_id, at);

create table hunt (                                -- saved search per truck
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  truck_id uuid not null references truck(id) on delete cascade,
  origin_city text, origin_radius_mi integer, dest_states text[],
  equipment equipment_type, min_rpm numeric, home_by timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table call (                                -- voice sessions (driver confirm, broker firewall)
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  load_id uuid references load(id),
  provider text, provider_call_id text, direction text, from_number text, to_number text,
  intent text, transcript text, recording_path text,
  minutes numeric, consent_given boolean,
  started_at timestamptz, ended_at timestamptz
);

create table ledger_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references org(id) on delete cascade,
  load_id uuid references load(id),
  category text not null,                          -- revenue | fuel | tolls | lumper | detention | maintenance | other
  amount numeric not null, source text,            -- rate_con | receipt | manual | bank
  document_id uuid references document(id),
  at timestamptz not null default now()
);

-- ---------- RLS ----------
-- security definer so the lookup itself is not blocked by the "user" table's own RLS (avoids recursion)
create or replace function current_org_id() returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from "user" where id = auth.uid()
$$;
revoke all on function current_org_id() from public;
grant execute on function current_org_id() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['org','user','truck','driver','facility','broker','load','stop','deal','document','score','event','hunt','call','ledger_line'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

create policy org_self on org for all using (id = current_org_id());
create policy org_bootstrap_insert on org for insert to authenticated with check (true);  -- first login creates the org
create policy user_self_org on "user" for all using (org_id = current_org_id());
create policy user_self_row on "user" for all using (id = auth.uid()) with check (id = auth.uid());  -- first login creates own row
create policy truck_org on truck for all using (org_id = current_org_id());
create policy driver_org on driver for all using (org_id = current_org_id());
create policy facility_org_or_shared on facility for select using (org_id is null or org_id = current_org_id());
create policy facility_org_write on facility for insert with check (org_id = current_org_id());
create policy facility_org_update on facility for update using (org_id = current_org_id());
create policy broker_org_or_shared on broker for select using (org_id is null or org_id = current_org_id());
create policy broker_org_write on broker for insert with check (org_id = current_org_id());
create policy broker_org_update on broker for update using (org_id = current_org_id());
create policy load_org on load for all using (org_id = current_org_id());
create policy stop_org on stop for all using (org_id = current_org_id());
create policy deal_org on deal for all using (org_id = current_org_id());
create policy document_org on document for all using (org_id = current_org_id());
create policy score_org on score for all using (org_id = current_org_id());
create policy event_org on event for all using (org_id = current_org_id());
create policy hunt_org on hunt for all using (org_id = current_org_id());
create policy call_org on call for all using (org_id = current_org_id());
create policy ledger_org on ledger_line for all using (org_id = current_org_id());

-- Drivers: read/write only their own truck's loads (tighten in EZ-010 tests)
-- Storage: create private bucket 'docs'; policy: (storage.foldername(name))[1] = current_org_id()::text

-- ---------- guardrails ----------
-- 1. No tool may create tables outside this file. 2. state changes only via the API's transition function,
-- which must insert an event row. 3. document.extracted is data: never interpolate into prompts as instructions.
