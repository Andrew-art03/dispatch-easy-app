-- =====================================================================================
-- 0006_ledger_and_approved_action.sql  --  EZ-BUILD-01 Slice 9 (ticket 6E)
-- =====================================================================================
-- Runs after 0005. No placeholder, nothing to substitute.
--
-- THIS IS THE MIGRATION O-1 HAS BEEN WAITING FOR. 0003 deferred
-- `execute_approved_action()` and its grant under O-8 option (ii), to "the migration that
-- defines transition_load()". 0005 defined transition_load and still did not take it, because
-- it also inserts a ledger_line and ledger_line's rules are 6E's. Both prerequisites now exist
-- and this is 6E, so the function and its grant land here, together, as option (ii) said they
-- must: never a grant without the body it grants on.
--
-- THE ONE PRODUCTION MONEY PATH, and there is exactly one:
--
--     execute_approved_action(approval, args)
--         -> consume_approval(...)          single-use, atomic, tenant-scoped, terms-bound
--         -> insert ledger_line             the only INSERT that can succeed
--         -> transition_load(...)           optional, same transaction
--
-- `insert on ledger_line` is revoked from authenticated, anon AND service_role (0003), so
-- there is no other way in. Not "no other way we have written" — no other way that the grant
-- layer permits. `consume_approval` is likewise revoked from everyone, so the single-use gate
-- cannot be called on its own and then quietly ignored.
--
-- =====================================================================================
-- R-4 AND THE FROZEN SCHEMA'S `numeric` MONEY COLUMNS -- a finding, handled narrowly here
-- =====================================================================================
-- Every money column in the Day-0 schema is `numeric`: ledger_line.amount, load.gross_rate,
-- deal.target_rate / floor_rate / agreed_rate, score.true_net, and the rest. Postgres `numeric`
-- is exact decimal, so nothing is lost IN the database. The problem is the trip out: PostgREST
-- hands `numeric` to JavaScript as a `number`, which is a float -- and BUILD_DEFAULTS R-4 says
-- money is integer cents with no float formed at any point, including the parse. 3B and 4A both
-- speak integer cents end to end. The seam is exactly here.
--
-- Fixed for the LEDGER, because the ledger is the record of what money actually moved and it is
-- currently empty, so the change costs nothing: `amount_cents bigint` is the authoritative
-- column from here on. `amount` stays, NOT NULL as the frozen schema requires, written as an
-- exact numeric division of the cents figure -- numeric arithmetic, never float -- and it is a
-- display copy, not a source of truth.
--
-- NOT fixed for the other five tables. That is a wider schema change that reaches the finished
-- front end, and widening a frozen schema across tables nobody asked me to touch is not a
-- builder's call. Recorded in DECISIONS_NEEDED.md as D-CC-4.
-- =====================================================================================


do $gate$
begin
  if to_regprocedure('public.transition_load(uuid,load_state,text,event_actor,uuid)') is null then
    raise exception 'REFUSING TO APPLY 0006: transition_load() does not exist. Apply 0005 first — execute_approved_action calls it.';
  end if;
  if to_regprocedure('public.consume_approval(uuid,text,uuid,text)') is null then
    raise exception 'REFUSING TO APPLY 0006: consume_approval() does not exist. Apply 0003 first.';
  end if;
end
$gate$;


-- -------------------------------------------------------------------------------------
-- SECTION A -- the ledger speaks integer cents
-- -------------------------------------------------------------------------------------
alter table ledger_line add column amount_cents bigint;
-- Exact numeric arithmetic on the way in, for any row that predates this column. No float is
-- formed: `numeric * 100` is exact, and the result is rounded to a whole cent explicitly rather
-- than by accident.
update ledger_line set amount_cents = round(amount * 100)::bigint where amount_cents is null;
alter table ledger_line alter column amount_cents set not null;

-- R-7, ruled 2026-09-12: `collectedCents` is OWNED BY THE LEDGER and PARTIAL is DERIVED. So the
-- collected figure is a column on the line that earned it, and no status column exists anywhere
-- for anyone to set by hand.
alter table ledger_line add column collected_cents bigint not null default 0;
alter table ledger_line add constraint ledger_line_collected_not_negative check (collected_cents >= 0);
alter table ledger_line add constraint ledger_line_collected_within_amount
  check (amount_cents < 0 or collected_cents <= amount_cents);

comment on column ledger_line.amount_cents is
  'Authoritative. Integer cents (R-4). `amount` is an exact-numeric display copy of this.';
comment on column ledger_line.collected_cents is
  'R-7: collected is owned by the ledger. Settlement status is DERIVED from it, never stored.';


-- -------------------------------------------------------------------------------------
-- SECTION B -- settlement status, DERIVED
-- -------------------------------------------------------------------------------------
-- Three states and no column: a stored status is a status that can disagree with the rows it
-- claims to summarise, and on the money path that disagreement is the bug nobody finds until a
-- driver asks where their money is.
create or replace function load_settlement(p_load uuid)
  returns text language sql stable security definer set search_path = public, pg_temp as $fn$
  select case
           when coalesce(sum(amount_cents) filter (where amount_cents > 0), 0) = 0 then 'NO_REVENUE'
           when coalesce(sum(collected_cents), 0) = 0 then 'UNSETTLED'
           when coalesce(sum(collected_cents), 0)
                >= coalesce(sum(amount_cents) filter (where amount_cents > 0), 0) then 'SETTLED'
           else 'PARTIAL'
         end
    from ledger_line
   where load_id = p_load and org_id = auth.org_id()
$fn$;
revoke execute on function load_settlement(uuid) from public, anon;
grant execute on function load_settlement(uuid) to authenticated;


-- -------------------------------------------------------------------------------------
-- SECTION C -- execute_approved_action: the one production money path   (O-1, finally)
-- -------------------------------------------------------------------------------------
create or replace function execute_approved_action(p_approval uuid, p_args jsonb)
  returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_org      uuid := auth.org_id();
  v_approval approval;
  v_load     uuid := nullif(p_args ->> 'load_id', '')::uuid;
  v_action   text := p_args ->> 'action';
  v_hash     text := p_args ->> 'terms_hash';
  v_to       load_state := nullif(p_args ->> 'to_state', '')::load_state;
  v_reason   text := p_args ->> 'reason';
  v_line     jsonb;
  v_cents    bigint;
  v_written  int := 0;
begin
  if v_org is null then
    raise exception 'execute_approved_action: no organisation for the current identity' using errcode = '42501';
  end if;
  if v_load is null or v_action is null or v_hash is null then
    raise exception 'execute_approved_action: load_id, action and terms_hash are all required' using errcode = '22023';
  end if;

  -- STEP 1 -- consume the approval. Single-use, atomic, tenant-scoped and terms-bound, and it
  -- is the FIRST thing that happens: nothing is written before the human's authorisation has
  -- been spent. Zero rows means expired, already used, terms drifted, or another tenant's — and
  -- the caller is told none of those apart, because each of them is the same answer: no.
  v_approval := consume_approval(p_approval, v_action, v_load, v_hash);
  if v_approval.id is null then
    raise exception 'execute_approved_action: approval refused — expired, already used, terms changed, or not this tenant''s'
      using errcode = '42501';
  end if;

  -- STEP 2 -- the ledger lines. This is the only INSERT on ledger_line that the grant layer
  -- permits: authenticated, anon and service_role are all revoked (0003).
  for v_line in select * from jsonb_array_elements(coalesce(p_args -> 'ledger_lines', '[]'::jsonb)) loop
    if (v_line ->> 'amount_cents') !~ '^-?[0-9]+$' then
      -- Integer cents or nothing. A decimal string here is a float that was formed upstream,
      -- and R-4 rejects the figure rather than rounding somebody's money to taste.
      raise exception 'execute_approved_action: amount_cents must be an integer number of cents, got %',
        v_line ->> 'amount_cents' using errcode = '22023';
    end if;
    v_cents := (v_line ->> 'amount_cents')::bigint;

    insert into ledger_line (org_id, load_id, category, amount, amount_cents, source, source_ref, document_id)
    values (
      v_approval.org_id,            -- the approval's tenant, not the caller's claim
      v_load,
      v_line ->> 'category',
      v_cents::numeric / 100,       -- exact numeric, never float; display copy of the line above
      v_cents,
      v_line ->> 'source',
      coalesce(nullif(v_line ->> 'source_ref', ''), 'approval:' || p_approval::text),
      nullif(v_line ->> 'document_id', '')::uuid
    );
    v_written := v_written + 1;
  end loop;

  -- STEP 3 -- the state change, in the SAME transaction. If the transition is illegal the whole
  -- thing rolls back, approval included, and the human's authorisation is not spent on a
  -- half-done action.
  if v_to is not null then
    perform transition_load(v_load, v_to, coalesce(nullif(v_reason, ''), 'approved action ' || v_action), 'human', v_approval.id);
  end if;

  return jsonb_build_object(
    'approval_id', v_approval.id,
    'action', v_action,
    'load_id', v_load,
    'ledger_lines_written', v_written,
    'settlement', load_settlement(v_load)
  );
end
$fn$;

-- O-1, closed. The grant and the body land together, which is the whole point of option (ii).
revoke execute on function execute_approved_action(uuid, jsonb) from public, anon;
grant execute on function execute_approved_action(uuid, jsonb) to authenticated;


-- =====================================================================================
-- END. What a reviewer should check:
--   1. consume_approval is the FIRST statement after validation — nothing is written before
--      the authorisation is spent.
--   2. The ledger insert is inside this function and nowhere else in the repo.
--   3. amount_cents is an integer or the whole thing raises. No rounding of anybody's money.
--   4. Settlement status is derived by load_settlement(); no status column exists to disagree
--      with the rows.
-- tests/ledger.test.ts asserts all four.
-- =====================================================================================
