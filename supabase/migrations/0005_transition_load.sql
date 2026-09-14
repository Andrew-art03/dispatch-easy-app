-- =====================================================================================
-- 0005_transition_load.sql  --  EZ-BUILD-01 Slice 6 (ticket 3A)
-- =====================================================================================
-- Runs after 0004. No placeholder, nothing for a human to substitute.
--
-- ONE FUNCTION, ONE TRANSACTION, FOUR STEPS IN THIS ORDER:
--   lock the row  ->  verify the transition is legal  ->  update  ->  insert the event.
--
-- The lock is first and it is what makes the rest true. Without `for update`, two taps that
-- arrive together both read `booked`, both find `booked -> in_transit` legal, both update, and
-- both insert an event -- one state change, two audit rows, and a detention clock that started
-- twice. With it, the second transaction waits, re-reads `in_transit`, finds `in_transit ->
-- in_transit` is not an edge, and is refused. SPEC 3A's "done when" is exactly that: a
-- concurrent double-transition produces ONE event, not two.
--
-- `status` MOVES ONLY THROUGH THIS FUNCTION -- and in this schema the column is `state`
-- (O-9, Slice 2: the spec's prose says `status`, the frozen schema says `state`). 0003 already
-- revoked `update (state) on load` from authenticated and anon, so there is no other way to
-- write it. This function is SECURITY DEFINER, which is how it is allowed to.
--
-- NO GENERIC STATE PATCH EXISTS ANYWHERE. The three route stubs in src/routes/api are named
-- intents -- confirm, pursue, skip -- not a PATCH that takes a target state from the caller.
-- tests/transition-load.test.ts asserts that, because "we simply won't add one" is not an
-- invariant, it is an intention.
--
-- ON execute_approved_action(): 0003 deferred it under O-8 option (ii) to "the migration that
-- defines transition_load()". Its prerequisite now exists, and it is still not here -- because
-- it also inserts a ledger_line, and ledger_line's business rules are 6E's (Slice 9). Defining
-- it here would mean defining half of 6E in a 3A migration, which is the same blast-radius
-- mistake option (ii) was chosen to avoid. It lands in 0006 with the ledger, and its grant
-- lands with it. Nothing can reach the money path before then, which remains the intended state.
-- =====================================================================================


do $gate$
begin
  if to_regprocedure('auth.org_id()') is null then
    raise exception 'REFUSING TO APPLY 0005: auth.org_id() does not exist. Apply 0004 first -- this function scopes by it.';
  end if;
  if to_regtype('load_state') is null then
    raise exception 'REFUSING TO APPLY 0005: the load_state enum does not exist. Apply 0001_baseline.sql first.';
  end if;
end
$gate$;


-- -------------------------------------------------------------------------------------
-- The legal edges.
--
-- Kept as a function returning a fixed array rather than as a table, on purpose: a table would
-- need RLS, a policy, an org_id exemption and a set of revokes to stop anyone editing the rules
-- of the state machine at runtime. A function body is already immutable to everyone who is not
-- running a migration.
--
-- These edges are the same ones in packages/domain/loadStateMachine.ts, and
-- tests/transition-load.test.ts parses BOTH and asserts they match edge for edge. A convenience
-- copy that drifts into a second, softer opinion is worse than no copy at all.
-- -------------------------------------------------------------------------------------
create or replace function load_legal_transitions() returns text[]
  language sql immutable as $fn$
  select array[
    'candidate_found>qualified',
    'candidate_found>rejected',
    'qualified>pursue_approved',
    'qualified>rejected',
    'pursue_approved>negotiating',
    'pursue_approved>rejected',
    'negotiating>terms_proposed',
    'negotiating>rejected',
    'terms_proposed>rate_con_received',
    'terms_proposed>negotiating',
    'terms_proposed>rejected',
    'rate_con_received>booked',
    'rate_con_received>rejected',
    'booked>in_transit',
    'booked>rejected',
    'in_transit>delivered',
    'delivered>billing_ready',
    'billing_ready>paid_reconciled',
    'paid_reconciled>learned'
  ]
$fn$;
-- learned and rejected are terminal: they appear on no left-hand side.
-- There are no self-edges. `x > x` is not a transition, and treating it as one is how a
-- double-tap writes a second event for an action that happened once.


-- -------------------------------------------------------------------------------------
-- transition_load() -- the only way load.state changes.
-- -------------------------------------------------------------------------------------
create or replace function transition_load(
  p_load uuid,
  p_to load_state,
  p_reason text,
  p_actor event_actor default 'human',
  p_correlation_id uuid default null
) returns load
  language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_load load;
  v_org  uuid := auth.org_id();
begin
  if v_org is null then
    raise exception 'transition_load: no organisation for the current identity'
      using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    -- Every state change carries a reason into the audit log. A state machine whose history
    -- says only "it moved" cannot answer the question anyone actually asks later.
    raise exception 'transition_load: a reason is required' using errcode = '22023';
  end if;

  -- STEP 1 -- the lock. Tenant-scoped in the same statement, so a row belonging to another org
  -- is simply not found; the caller cannot tell "not yours" from "does not exist", which is the
  -- correct amount for them to learn.
  select * into v_load from load where id = p_load and org_id = v_org for update;
  if not found then
    raise exception 'transition_load: load not found' using errcode = '42501';
  end if;

  -- STEP 2 -- legality, decided AFTER the lock. Deciding before it is deciding on a value that
  -- may already be stale by the time the update runs.
  if not (v_load.state::text || '>' || p_to::text) = any (load_legal_transitions()) then
    raise exception 'transition_load: % -> % is not a legal transition', v_load.state, p_to
      using errcode = '23514';
  end if;

  -- STEP 3 -- the update.
  update load set state = p_to, updated_at = now() where id = p_load returning * into v_load;

  -- STEP 4 -- the event, in the same transaction. If the insert fails, the state change is not
  -- kept either: an unaudited state change is the thing rule 10 exists to prevent.
  insert into event (org_id, load_id, type, actor, actor_user_id, payload)
  values (
    v_org,
    p_load,
    'state.' || p_to::text,
    p_actor,
    case when p_actor = 'human' then auth.uid() else null end,
    jsonb_build_object(
      'from', v_load.state,
      'to', p_to,
      'reason', p_reason,
      'correlation_id', p_correlation_id
    )
  );

  return v_load;
end
$fn$;

-- The one production path. Callers hold a user JWT; the function is definer, so it may write a
-- column their own grants forbid -- which is the entire point of it existing.
revoke execute on function transition_load(uuid, load_state, text, event_actor, uuid) from public, anon;
grant execute on function transition_load(uuid, load_state, text, event_actor, uuid) to authenticated;
revoke execute on function load_legal_transitions() from public, anon;
grant execute on function load_legal_transitions() to authenticated;


-- =====================================================================================
-- END. What a reviewer should check:
--   1. The lock is the FIRST statement that touches the row, before any legality decision.
--   2. The update and the event insert are in one transaction, with no commit between them.
--   3. No self-edge appears in load_legal_transitions().
--   4. Nothing else in the repo writes load.state.
-- tests/transition-load.test.ts asserts all four mechanically.
-- =====================================================================================
