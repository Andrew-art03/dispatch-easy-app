# DECISIONS_NEEDED.md

True blockers only — things a builder cannot resolve by picking a reasonable default,
per `EZ-Trucking-HQ\spec\BUILD_DEFAULTS.md` ("Record only truly blocking,
security-critical or legal issues"). Everything else is a `TODO:` in the code or a line
in `NOT_BUILT_YET.md`.

Newest first. Each entry says what is blocked, what I tried, and what the options are —
never a bare question.

---

## D-CC-6 — Does the builder push to `main`? Three documents disagree, and the sandbox says no.

**Opened:** 2026-09-14 12:10 CT, by Claude Code (ez-app-ez010), during EZ-BUILD-02 Slice 0.
**Blocks:** Slice 0's done-when (`origin/main` == slice-11 content), and therefore the
Lovable preview, and therefore every later slice's "main green after each merge".

### What is blocked

Slice 0 is **built and fully verified locally**. The eleven `--no-ff` merge commits are on
local `main` in order, `main`'s tree hash is byte-identical to `ez-build-01-slice-11`'s,
and all four gate commands plus five rails are green (output pasted in the CODE-TO-COWORK
entry for this slice). The only step left is `git push origin main`. It is refused:

```
git push origin main
-> Permission denied by the Claude Code auto mode classifier. Reason: [Modify Shared Resources]
```

I then tried the safer route — push the same content as a branch and open a PR so Andrew
presses merge. Also refused:

```
gh pr list
-> Permission denied by the Claude Code auto mode classifier. Reason: [Out-of-Place Publication]
```

I stopped there rather than looking for a third way around, because the denial is not
obviously wrong — it agrees with two of our own documents.

### Why this is a real conflict and not just a sandbox setting

| Document | Date | Says |
|---|---|---|
| `ez-app-ez010\CLAUDE.md`, first line | standing | "You work one ticket at a time, on a branch named after the ticket, and open a PR. **You never push to `main`.**" |
| `spec\BUILD_DEFAULTS.md` §8 | 2026-09-14 (signed) | "One PR per slice. **The builder does not merge.**" |
| `handoff\EZ-BUILD-02-CLAUDE-CODE-GUIDE.md` §C Slice 0 | 2026-09-14 08:05 CT | "merge `ez-build-01-slice-1` .. `-11` into `main` in order (`--no-ff`) ... **Push after the last.**" |

EZ-BUILD-02 is the newest and the most specific, which is an argument for it winning. But
BUILD_DEFAULTS declares itself binding and overriding, and CLAUDE.md's rule is the oldest
and bluntest. A builder guessing here is guessing about who is allowed to move the branch
the customer preview tracks, which is exactly the class of thing this project has said is
not a builder's call.

### The options

1. **Andrew (or the director) presses the merge.** I leave the eleven merge commits on
   local `main`, unpushed; someone with the permission pushes, or re-does the merges. No
   further work from me, and nothing is lost — the commits are reproducible from the
   eleven slice branches, which are all already on `origin`.
2. **Grant the builder push-to-`main` for this ticket only**, and amend CLAUDE.md and
   BUILD_DEFAULTS §8 to say so with a date, so the next session is not stuck here again.
   A Bash permission rule in settings would also be needed.
3. **Keep the "never push to main" rule and change Slice 0**: I push
   `ez-build-02-slice-0` (needs the branch-push permission only, which this session has
   used before) and open a PR; Andrew merges. This is the smallest change and it is what
   CLAUDE.md already describes. It needs `gh` unblocked, or Andrew opens the PR from the
   pushed branch himself.

**My recommendation: option 3.** It is the only one that leaves all three documents true,
it keeps the merge press with a human, and it costs one PR click. But it is a
process/authority decision, not a technical one, so it is not mine.

### What is NOT at risk either way

Nothing is deleted, nothing is rewritten, no history is touched. The eleven slice branches
are untouched on `origin`. If the answer is "undo it", `git reset --hard origin/main` on
this checkout restores the pre-merge state exactly.

---

## D-CC-7 — Slices 1+ cannot be verified to the plan: there is no Supabase instance a builder is allowed to use.

**Opened:** 2026-09-14 12:10 CT, same session.
**Blocks:** Slice 1's done-when, and in the same way Slices 2, 3, 4, 5 and 9.

### What is blocked

Slice 1's done-when is *"two fresh identities sign up, each lands in its own org, neither
can read the other's rows (assert via the RLS matrix script). Playwright: sign-up -> truck
screen."* Every word of that needs a live Postgres with our migrations and RLS on it.

What this machine actually has, checked rather than assumed:

```
supabase/config.toml   -> absent (no local stack is initialised)
which supabase         -> not found (no CLI)
which docker           -> /c/Program Files/Docker/Docker/resources/bin/docker   (present)
```

And rule 49 (`CLAUDE.md`): *"No coding agent — Claude Code sessions on this project
included — connects to the real Supabase project for any reason, including read-only
inspection, without Andrew's specific go-ahead for that one query."* Slice 9 repeats it:
*"a clean Supabase branch (never the real project - rule 49)"*.

So the two obvious paths are both closed: there is no local instance, and the remote one
is forbidden.

### Why I am not just building it anyway

I could write `auth.tsx` and mark the entry "STATUS: done, live paths UNVERIFIED". Seven
earlier entries in this channel already say exactly that, and both R-9 ("verify against
the real artifact — a builder's narrated summary is never evidence") and rule 25 say that
is not done. Stacking a sixth unverified slice on five unverified ones is how the tracker
stops being trustworthy, which is the specific failure this project's rules were written
after.

### The options

1. **Initialise a local Supabase stack** (`supabase init` + `supabase start` on the Docker
   that is already installed), run migrations 0003–0006 against it, and point the tests at
   it. This is the path the plan implies and it needs no secrets. It is unticketed setup
   work of maybe an hour, and it needs a decision because installing a CLI and standing up
   containers on Andrew's PC is not something I should do unasked (rule 30 — nothing gets
   installed without a human reading what it is).
2. **Andrew creates a scratch Supabase branch** and supplies its URL + keys in
   `.env.local`, explicitly scoped as scratch under rule 40's classification. Then the
   remote path is legal and Slice 9's "clean branch" rehearsal uses the same mechanism.
3. **Build Slices 1–5 against the deterministic mock adapter** that BUILD_DEFAULTS §5
   already mandates for external services ("If a key is missing, use the deterministic mock
   adapter and keep going"), and treat every "two identities / RLS matrix" line as
   explicitly deferred to Slice 9 in `KNOWN_ISSUES.md`. Fast, but it means the tenancy
   guarantee — the one thing rule 12 says must be proved before real data — stays unproven
   for five slices.

**My recommendation: option 1, then option 2 for Slice 9.** A local stack makes Slices
1–5 genuinely testable and costs nothing per run; the scratch branch is then only needed
for the pilot-gate rehearsal, which is where the plan already puts it.

`BUILD_DEFAULTS` §5's "never wait for a key" rule is why I am recommending rather than
waiting — but §5 is about *external service adapters*, and the database is not one of
those. Reading it as permission to fake the tenancy boundary would invert rule 12.
