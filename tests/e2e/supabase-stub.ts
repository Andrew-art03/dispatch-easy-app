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
  options: { firstLogin?: boolean; user?: StubUser } = {},
) {
  const user = options.user ?? EXISTING;
  const firstLogin = options.firstLogin ?? false;
  let userRowExists = !firstLogin;

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

    // Everything else: an empty collection. A screen that cannot render "nothing yet" is a
    // screen with a missing empty state, and that is a defect worth failing on.
    return json(route, method === "POST" ? [] : []);
  });
}
