# NOT_BUILT_YET.md

Things a slice wanted that the frozen schema does not hold, and version-2 ideas parked by
design. `BUILD_DEFAULTS` §2: *"If a screen needs a column that is not there, the screen
adapts, the schema does not (record it in NOT_BUILT_YET.md)."*

Nothing here is a defect. Each entry says what was asked for, what the screen does instead,
and what it would take to build properly — so the decision is visible rather than lost in a
diff.

Newest first.

---

## Two of the three HOS figures · EZ-BUILD-02 Slice 2

**Asked for:** *"HOS three hand-typed fields labelled 'your numbers, not your log'."*

**What the schema holds:** one column, `driver.hos_hours_left numeric` — commented in
`0001_baseline.sql` as *"manual until ELD linked"*. Checked rather than assumed:

```sql
select column_name from information_schema.columns
 where table_name = 'driver' and column_name like '%hos%';
-- hos_hours_left
```

**What the screen does instead:** asks for the one figure the schema can keep — *"Hours you
have left to drive"*, hinted *"Your numbers, not your log. EZ uses it to see if a load fits
today."* It is an input only and is never rendered as a clock; `tests/e2e/truck.spec.ts`
asserts both, and `tests/db/truck.test.ts` pins the single-column reading so nobody "fixes"
this by adding columns to a frozen schema.

**To build it properly** the other two would be the rest of the standard picture — on-duty
hours left and the 70-hour cycle — which means two columns on `driver` and a decision about
whether EZ ever reasons about them or merely records them. That is a schema ticket and a
product question, not a screen change.

**Cost of not having them:** EZ's "does this load fit today?" check sees drive hours only.
For a driver near their weekly cycle limit, a load EZ says fits may not. Worth naming
before the pilot, since it is the kind of gap a driver discovers at a shipper's gate.

---

## Truck colour does not follow the driver to another device · EZ-BUILD-02 Slice 2

**Asked for:** *"colour/body persist."*

**What happens today.** **Body** genuinely persists: the picker writes `truck.equipment`,
which is a frozen-schema column, so it follows the account everywhere. **Colour** does not —
`useTruckColor` keeps it in `localStorage` under `ez-truck-color`, because `truck` has no
colour column and §2 forbids adding one.

So colour survives a reload on the same phone, and is back to the default on a new phone or
after clearing site data. `tests/e2e/truck.spec.ts` asserts the behaviour that exists rather
than the behaviour that was asked for.

**To build it properly:** one `text` column on `truck` and the picker writing it like the
body picker already does. Small, but it is a schema change.

**Cost of not having it:** cosmetic only. Nothing about money, a load, or a decision
depends on it.

---

## Joining an existing org needs an invitation · carried from migration 0004

Named in `0004_rls_force_and_org_id.sql` when O-13 was closed: a self-insert into `user` is
allowed only into an org with no users yet, which is the first-login bootstrap and nothing
else. There is therefore **no way for a second person to join a carrier's org** — no
invitation, no accept, no role assignment beyond the first owner.

Correct for a single-driver pilot and a real gap for any carrier with a dispatcher. The
policy shape it needs is already sketched in 0004's header.

---

## `org_bootstrap_insert` is `with check (true)` · carried from migration 0004

Any authenticated user can create an org row with any contents. It is how sign-up works
today, and narrowing it changes the sign-up flow, which 0004 recorded as a product decision
rather than a builder's. Named here so it is not mistaken for an oversight.
