# DECISIONS_NEEDED.md

True blockers only — things a builder cannot resolve by picking a reasonable default,
per `EZ-Trucking-HQ\spec\BUILD_DEFAULTS.md` ("Record only truly blocking,
security-critical or legal issues"). Everything else is a `TODO:` in the code or a line
in `NOT_BUILT_YET.md`.

Newest first. Each entry says what is blocked, what I tried, and what the options are —
never a bare question.

---

## D-CC-8 — Docker Desktop will not start its engine unattended. One human click unblocks Slices 1–5.

> ### ✅ RESOLVED 2026-09-14 14:05 CT — Director. **There is no Docker dependency.**
>
> Docker is not coming back today: Docker Desktop dies at launch because the machine-level
> `ProgramData` / `ALLUSERSPROFILE` variables are empty, the fix needs an elevated shell,
> and Andrew's attempt was refused. `supabase start` was the wrong next command.
>
> Ruled: use the `embedded-postgres` harness the Easy Eats build proved on this same
> machine — a real PostgreSQL binary managed by the package manager, no daemon, no
> container, no administrator. My one-click framing was wrong, and the "needs no further
> decision from anyone" line in my 14:00 entry needed exactly this one.
>
> **Carried out, same day:** `scripts/with-test-db.ts` on port 55433 (55432 belongs to
> another build and is untouched), the chain 0001/0003/0004/0005/0006 applied, the RLS
> matrix and the tenancy suite behind `bun run test:db`, `bun run test` left free of any
> database so the 24/784 floor never depends on one. Playwright installed. Two real
> defects found on first contact — see `QA_ISSUES.md` Q-1 and Q-2.
>
> `supabase/config.toml` is kept, per the ruling: it costs nothing and Slice 9 will use it
> against the scratch branch Andrew supplies. It is simply not on today's path.

**Opened:** 2026-09-14 13:50 CT, by Claude Code (ez-app-ez010), during EZ-BUILD-02 Slice 1.
**Blocks:** the live half of Slice 1's done-when, and the same in Slices 2–5.
**Cost to unblock: one person opening Docker Desktop once and clearing whatever it is asking.**

### What happened

D-CC-7 authorised the local stack and I stood up everything that does not need the daemon:

- Supabase CLI **2.117.0** installed (`npm install -g supabase`) — recorded with its teardown
  in `KNOWN_ISSUES.md`, as the ruling requires.
- `supabase init --force` succeeded; `supabase/config.toml` is in the repo.
- The static half of Slice 1's done-when is **green** — `assert-rls-matrix.mjs` passes and its
  self-test goes red on every planted positive.

`supabase start` is where it stops, and the reason is Docker, not Supabase:

```
{"_tag":"Error","error":{"code":"LegacyDockerLifecycleInspectError","message":"failed to
inspect container health: failed to connect to the docker API at
npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon
is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified."}}
```

### What I tried, and what the evidence says

| Step | Result |
|---|---|
| `nohup "Docker Desktop.exe"` from bash | no process appeared — the launch did not take |
| `Start-Process 'Docker Desktop.exe'` via PowerShell | **worked** — `Docker Desktop` + two `com.docker.backend` processes running |
| polled `docker info` for ~10 minutes | pipe never appears |
| `wsl -d docker-desktop -e echo ok` | prints `ok`; distro goes `Stopped` -> **`Running`** |
| `docker info` after the distro is up | still no engine |
| `settings-store.json` -> `AcceptedTermsOfService` | **empty** |

So: the app runs, its WSL distro runs, and the engine is never published. An empty
`AcceptedTermsOfService` on a machine where the distro already exists points at a first-run
or terms dialog sitting on the desktop, waiting for a click I cannot give it and should not
give it — accepting a vendor's terms on Andrew's behalf is not a builder's call.

### Why I did not route around it

The Director's own fallback is "plain Postgres in Docker" — which needs the same daemon. The
other route would be an embedded-Postgres npm package, which is a **new third-party
dependency**; rule 30 says a human reads the source first, and D-CC-7 authorised the Supabase
CLI specifically, not a general licence to add packages. And the ruling is explicit: **do not
fall back to mocks for the tenancy tests.** Rule 12 says the tenant boundary must be proved
before real data, so proving it against a fake is worse than not proving it yet.

### The options

1. **Andrew (or anyone at the keyboard) opens Docker Desktop once** and clears the dialog.
   Then `supabase start` needs no further decision — the CLI is installed, the config is
   committed, and the next session runs migrations 0003–0006 and builds Slice 1 straight
   through. **Recommended: it is one click and it unblocks five slices.**
2. **Grant the build permission to add `embedded-postgres`** (or `pg` + a system Postgres) as
   a devDependency, read under rule 30. Real Postgres, no Docker, no daemon. More moving
   parts, and Supabase Auth would still be absent — `auth.uid()` / `auth.org_id()` would need
   stubbing in the harness, which weakens the very test Slice 1 exists to run.
3. **Do Slices 2–6 first and come back to 1.** They have the same dependency, so this only
   changes the order in which we get stuck.

**Recommendation: option 1.** Options 2 and 3 both spend real effort to avoid one click.

### What is ready the moment Docker is up

`supabase start` -> apply `0003`–`0006` -> point the tests at the local URL -> build the
two-identity isolation test and the Playwright sign-up case. Nothing else is waiting on a
decision. Playwright is deliberately not installed yet (`KNOWN_ISSUES.md`): the constraint is
the database, not the browser driver.

---

## D-CC-6 — Does the builder push to `main`? Three documents disagree, and the sandbox says no.

> ### ✅ RESOLVED 2026-09-14 13:30 CT — Director. **Option 3.** The builder never pushes `main`.
>
> `CLAUDE.md` and `BUILD_DEFAULTS` §8 stand. The Director's own guide was the thing that was
> wrong: EZ-BUILD-02 §C Slice 0's "Push after the last" contradicted two signed documents and
> has been corrected in the guide with a dated note. The eleven merge commits are kept.
>
> Slice 0's done-when is amended to **"the branch is on `origin` and the PR exists"** — or the
> branch is on origin and `gh` is reported refused. `origin/main` moving is the Director's step.
>
> **Carried out, same day:** `git push origin HEAD:refs/heads/ez-build-02-slice-0` succeeded;
> `origin/ez-build-02-slice-0` == `4a98d67`, re-read from the remote. The PR was NOT opened —
> `gh` is not installed on this machine (`gh: command not found`, exit 127), which is a
> different failure from the earlier classifier refusal. Per the ruling I stopped there rather
> than look for a third route. GitHub's compare link, from the push output:
> `https://github.com/Andrew-art03/dispatch-easy-app/pull/new/ez-build-02-slice-0`

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

> ### ✅ RESOLVED 2026-09-14 13:30 CT — Director. **Option 1 now, option 2 at Slice 9.**
>
> A local Supabase stack is authorised explicitly, under the charter: technical tooling, no
> cost, reversible, local only. Install the Supabase CLI, `supabase init` + `supabase start`
> against the Docker already on this machine, apply migrations 0003–0006, point the Slice 1–5
> tests and the RLS matrix script at it. `.env.local` holds the local stack's keys only.
>
> Conditions, all binding:
> - Record exactly what was installed and its version in the reply entry.
> - Add a **teardown** line to `KNOWN_ISSUES.md` saying how to remove it.
> - **Rule 49 is untouched.** The real project stays off limits, not even read-only.
> - Slice 9 uses a scratch branch Andrew supplies; until then it runs against the local stack
>   and the reply entry says so.
> - If `supabase start` fails, fall back to plain Postgres in Docker with the migrations
>   applied, and say so. **Do not fall back to mocks for the tenancy tests.**
>
> The Director confirmed the reading that prompted this: §5's "never wait for a key" governs
> external service adapters, and the database is not one of those — faking the tenancy
> boundary would invert rule 12.

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
