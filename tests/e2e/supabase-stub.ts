/**
 * The deterministic Supabase stub for browser tests — BUILD_DEFAULTS §5.
 *
 * WHAT THIS IS ALLOWED TO STAND IN FOR, and what it is not.
 *
 * Supabase Auth and PostgREST are SERVICES, and §5 says a service with no key gets a
 * deterministic mock rather than a blocked build. That is what this is: it answers the
 * HTTP calls `@supabase/supabase-js` makes, so the SCREENS can be driven in a browser.
 *
 * It is emphatically NOT where the tenant boundary is tested. Rule 12's guarantee — two
 * carriers, two orgs, neither reading the other's rows — is proved in
 * `tests/db/tenancy.test.ts` against real PostgreSQL with the real policies, because a
 * mocked RLS test proves only that the mock returned what the test asked for. Nothing in
 * this file may ever be cited as evidence about RLS, and it deliberately implements no
 * policy logic at all: every request it receives, it answers.
 *
 * Keep it dumb for that reason. The moment this starts deciding who may see what, a
 * reviewer has to work out whether a green browser test means the product is safe. It
 * never does.
 */
import type { Page, Route } from "@playwright/test";

export type StubUser = {
  authUserId: string;
  email: string;
  orgId: string;
  orgName: string;
};

/** A `truck` row as PostgREST would return it. Shaped by the frozen schema, not invented. */
export type StubTruck = Record<string, unknown> & { id: string; org_id: string };

/** A row already exists — the returning-user path. */
export const EXISTING: StubUser = {
  authUserId: "11111111-1111-4111-8111-111111111111",
  email: "owner@freedom-trucking.test",
  orgId: "22222222-2222-4222-8222-222222222222",
  orgName: "Freedom Trucking LLC",
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  });

/**
 * Install the stub on a page.
 *
 * `firstLogin: true` models a brand-new account: the `user` lookup finds nothing, so the
 * app takes the bootstrap path — insert org, insert user. That is the path the database
 * suite found broken, so the browser case is worth having even though the proof lives
 * elsewhere: this one checks the SCREEN survives it.
 */
export async function installSupabaseStub(
  page: Page,
  options: {
    firstLogin?: boolean;
    user?: StubUser;
    /** The `truck` row the screen should load, or null for a driver with none yet. */
    truck?: StubTruck | null;
    /** The `driver` row, for the hand-typed hours-left figure. */
    driver?: Record<string, unknown> | null;
    /**
     * Seed a stored session so protected routes open directly. Default FALSE.
     *
     * The default is off deliberately: a stub that signs you in without being asked would
     * make every sign-in test pass by redirecting past the screen it meant to check, which
     * is exactly what happened the first time this option existed.
     */
    signedIn?: boolean;
    /**
     * Whether the cold-open film has already played this browser session. Default true.
     *
     * `WeekGoalColdOpenHost` is mounted in `__root.tsx` and plays once per session on
     * whatever screen the driver lands on first — so for every screen AFTER that first
     * one, "already played" is the state a driver is actually in, and it is the right
     * default for tests that are about some other screen. Set it false in the case that is
     * about the film itself (Slice 4, which owns that feature).
     *
     * This is not a workaround for a defect: Q-2 was the film showing to a SIGNED-OUT
     * visitor, and that is fixed. Whether it should also be scoped to the home screen for a
     * signed-in driver who deep-links to Settings is a question for Slice 4, recorded in
     * QA_ISSUES.md rather than decided here.
     */
    coldOpenPlayed?: boolean;
  } = {},
) {
  const user = options.user ?? EXISTING;
  const firstLogin = options.firstLogin ?? false;
  let userRowExists = !firstLogin;
  // Writes are kept in memory so a save followed by a refetch shows what was written —
  // enough for the SCREEN. What the database actually keeps is proved in tests/db/.
  let truck = options.truck ?? null;
  let driver = options.driver ?? null;

  const session = {
    access_token: "stub-access-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "stub-refresh-token",
    user: {
      id: user.authUserId,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      user_metadata: { company_name: user.orgName },
      app_metadata: {},
      created_at: new Date().toISOString(),
    },
  };

  /**
   * Seed the stored session, so a test can open a screen behind the `_authenticated`
   * guard directly instead of driving the sign-in form first.
   *
   * This is needed because the guard asks the client for a session and the client answers
   * from localStorage, not from the network — so intercepting HTTP alone leaves every
   * protected route redirecting to /auth. `addInitScript` runs before the app's own code
   * on every navigation in this context, which is what makes it survive `page.reload()`.
   *
   * The storage key is supabase-js's own convention, `sb-<project ref>-auth-token`, with
   * the ref taken from the URL the app is built against.
   */
  if (options.signedIn ?? false) {
    const ref = (process.env["VITE_SUPABASE_URL"] ?? "https://efeaylkqgqhobookcqby.supabase.co")
      .replace(/^https?:\/\//, "")
      .split(".")[0];
    await page.addInitScript(
      ([key, value]) => {
        try {
          window.localStorage.setItem(key as string, value as string);
        } catch {
          // A browser with storage disabled is a different test.
        }
      },
      [`sb-${ref}-auth-token`, JSON.stringify(session)] as const,
    );
  }

  if (options.coldOpenPlayed ?? true) {
    await page.addInitScript(() => {
      try {
        window.sessionStorage.setItem("ez-coldopen-played", "1");
      } catch {
        // Storage disabled: the film plays, and the test that cares will say so.
      }
    });
  }

  await page.route("**/auth/v1/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/token") || url.includes("/signup")) return json(route, session);
    if (url.includes("/user")) return json(route, session.user);
    if (url.includes("/otp")) return json(route, {});
    if (url.includes("/logout")) return json(route, {});
    return json(route, session);
  });

  await page.route("**/rest/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const table = url.pathname.split("/rest/v1/")[1]?.split("?")[0] ?? "";
    const method = request.method();

    if (table === "user") {
      if (method === "POST") {
        userRowExists = true;
        return json(route, [], 201);
      }
      return json(
        route,
        userRowExists
          ? { id: user.authUserId, org_id: user.orgId, role: "owner", full_name: null, org: { name: user.orgName } }
          : null,
      );
    }

    if (table === "org") {
      if (method === "POST") return json(route, [], 201);
      return json(route, { id: user.orgId, name: user.orgName });
    }

    if (table === "truck") {
      if (method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        truck = { id: "stub-truck", org_id: user.orgId, ...body } as StubTruck;
        return json(route, [], 201);
      }
      if (method === "PATCH") {
        const body = request.postDataJSON() as Record<string, unknown>;
        truck = { ...(truck ?? { id: "stub-truck", org_id: user.orgId }), ...body } as StubTruck;
        return json(route, [], 200);
      }
      // `maybeSingle()` wants the object or null, never an array.
      return json(route, truck);
    }

    if (table === "driver") {
      if (method === "POST") {
        driver = { id: "stub-driver", ...(request.postDataJSON() as Record<string, unknown>) };
        return json(route, [], 201);
      }
      if (method === "PATCH") {
        driver = { ...(driver ?? { id: "stub-driver" }), ...(request.postDataJSON() as Record<string, unknown>) };
        return json(route, [], 200);
      }
      return json(route, driver ? { id: "stub-driver", ...driver } : null);
    }

    // Everything else: an empty collection. A screen that cannot render "nothing yet" is a
    // screen with a missing empty state, and that is a defect worth failing on.
    return json(route, method === "POST" ? [] : []);
  });
}
