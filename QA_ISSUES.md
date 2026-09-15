# QA_ISSUES.md

Defects found by testing, with the evidence that found them. Slice 8 runs the agent QA loop
against this file; entries before then come from the slice that found them.

Status is one of: **OPEN** · **FIXED (unverified)** · **FIXED (verified)** — "verified"
means a second run, after the fix, by the thing that found it.

Newest first.

---

## Q-3 — The cold-open film plays over whatever screen the session starts on · Severity: LOW · OPEN (Slice 4 owns it)

**Found by:** `tests/e2e/truck.spec.ts`, EZ-BUILD-02 Slice 2, 2026-09-14, while testing the
settings screen as a signed-in driver.

**What happens.** Q-2 stopped the film showing to signed-out visitors, and that is fixed.
For a SIGNED-IN driver it still plays once per browser session on whatever screen they land
on first — so a driver who deep-links to Settings, or refreshes there, gets a full-screen
week-goal film over the settings form before they can use it.

**Why this is filed rather than fixed.** It may be correct: it is a cold open for the app,
not for a screen, and `sessionStorage` means it happens once. But the ticket scopes the
animation to the home/goal screens ("cold-open animation once per cold open", Slice 4), and
Slice 4 owns that feature. Redesigning another slice's behaviour from inside Slice 2 is how
two slices end up disagreeing about the same component.

**What Slice 4 has to decide:** does the film play on any first screen, or only on home/goal?

**How the tests handle it meanwhile:** `installSupabaseStub` seeds the "already played"
flag by default, which is the state a driver is in for every screen after their first. The
case that is about the film itself will set it false. That default is documented in the stub
as a modelling choice, not a workaround.

---

## Q-2 — The cold-open film covered the sign-in form and swallowed every tap · Severity: HIGH · FIXED (verified)

**Found by:** `tests/e2e/auth.spec.ts`, EZ-BUILD-02 Slice 1, 2026-09-14. The first browser
test ever run against this screen.

**What a driver saw.** Open the app cold, signed out. A full-screen panel
(`fixed inset-0 z-50`) plays a week-goal film showing SAMPLE earnings, on top of the sign-in
form. Nothing underneath it can be tapped until "Continue" is found. On a phone, in a truck
stop, that is the first thing a new user meets.

**Evidence:**

```
locator resolved to <button type="button" …>Create account</button>
attempting click action
  element is visible, enabled and stable
  <svg …data-tsd-source="/src/components/WeekGoalColdOpen.tsx:471:13"> from
  <div …data-tsd-source="/src/components/WeekGoalColdOpenHost.tsx:76:5"
       class="fixed inset-0 z-50 overflow-y-auto bg-background px-3.5 py-5">
  subtree intercepts pointer events
Test timeout of 30000ms exceeded.
```

**Cause.** `WeekGoalColdOpenHost` is mounted in `src/routes/__root.tsx`, so it renders on
every route, `/auth` included. Its only gate was a `sessionStorage` flag. It *fetched* ledger
data only when a session existed, but it *displayed* regardless.

**Two defects, one gate.** A signed-out visitor could not use the screen (A-03 — ease of use
is a release criterion), and was shown a week of earnings before the product knew who they
were.

**Fix.** `src/components/WeekGoalColdOpenHost.tsx` now checks for a session before anything
else. The session check runs *before* the once-per-cold-open flag is consumed — burning the
flag on the auth screen would mean the driver never saw the film on the home screen they
actually signed in to, trading one defect for a quieter one.

**Verified:** the same suite, after the fix — `12 passed (49.2s)`, phone and desktop. Before
the fix the run took 5.9 minutes, almost all of it click timeouts.

---

## Q-1 — Sign-up was broken for every new account · Severity: CRITICAL · FIXED (verified)

**Found by:** `tests/db/tenancy.test.ts`, EZ-BUILD-02 Slice 1, 2026-09-14. The first time the
bootstrap path had ever run against a real database with the real policies on it.

**What a driver saw.** Create an account. It fails. The org row is created, then refused to
its own creator:

```
error: new row violates row-level security policy for table "org"
```

**Cause.** `loadOrBootstrapMe()` in `src/lib/session.ts` did
`.insert({ name }).select("id, name").single()`. The INSERT was always fine —
`org_bootstrap_insert` is `with check (true)`. The `RETURNING` was not: Postgres applies the
SELECT policy to the new row, `org_self` is `id = auth.org_id()`, and during a first login
`auth.org_id()` is NULL because the caller has no `user` row yet.

**Fix.** The org id is chosen client-side, so no `RETURNING` is needed. Fixing the client
rather than the policy was the only option open: the schema is frozen (BUILD_DEFAULTS §2),
and loosening `org_self` to make `RETURNING` work would make every org readable by everyone.
It weakens nothing — a client picking an existing id fails on the primary key, and
`user_bootstrap_insert` still independently requires
`id = auth.uid() and org_has_no_users(org_id)`.

**Verified:** `17 passed (17)` on the database suite, including a regression case that asserts
the `RETURNING` form still fails *and* that the same insert without it succeeds — so the case
is about `RETURNING` and not about the insert.

---

## Why these were invisible until Slice 1

Q-1 and Q-2 are not subtle and neither needed a clever test. Q-1 needed *a database* and Q-2
needed *a browser*, and until Slice 1 the build had neither. Eleven slices of EZ-BUILD-01
reported green against a suite that, by design, stands up no service — the right design for a
floor and the wrong thing to mistake for coverage of the product.

Q-3 is the same lesson in a quieter form: it was sitting in front of every screen behind the
sign-in wall, and it took a browser opening one of those screens to see it.
