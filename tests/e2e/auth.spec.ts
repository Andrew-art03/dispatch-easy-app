/**
 * EZ-BUILD-02 Slice 1 — sign-in and first-login bootstrap, in a real browser at phone size.
 *
 * SCOPE, stated up front so this is not mistaken for something it is not. These cases prove
 * the SCREEN: that the form renders, that its loading and error states exist and are
 * legible, that a brand-new account gets through the bootstrap without a dead end, and that
 * a session survives a reload. The tenant boundary is NOT proved here — it is proved in
 * `tests/db/tenancy.test.ts` against real PostgreSQL, because the Supabase services are
 * stubbed in this file (BUILD_DEFAULTS §5) and a stub cannot testify about RLS.
 *
 * 393x852 is the default viewport for the whole project. A driver opens this on a phone in
 * a truck stop; that is the judge (QUALITY-STANDARD), and A-03 makes ease of use a release
 * criterion, so "the button is reachable and says what it does" is a real assertion here
 * rather than a nicety.
 */
import { expect, test } from "@playwright/test";
import { EXISTING, installSupabaseStub } from "./supabase-stub";

/**
 * The screen has TWO controls reading "Sign in" and two reading "Create account": the mode
 * tabs at the top and the form's submit button. Selecting on the text alone is a strict-mode
 * violation, and resolving it with `.nth(1)` would be a test that silently follows whichever
 * one the DOM happens to put second. These name the role each control actually plays.
 */
const modeTab = (page: import("@playwright/test").Page, name: "Sign in" | "Create account") =>
  page.locator('button[type="button"]').filter({ hasText: new RegExp(`^${name}$`) });
const submit = (page: import("@playwright/test").Page) => page.locator('form button[type="submit"]');

test.describe("the sign-in screen", () => {
  test("renders both modes and tells the driver what this is", async ({ page }) => {
    await installSupabaseStub(page);
    await page.goto("/auth");

    await expect(page.getByRole("heading", { name: "EZ Trucking" })).toBeVisible();
    await expect(modeTab(page, "Sign in")).toBeVisible();
    await expect(modeTab(page, "Create account")).toBeVisible();
    await expect(submit(page)).toHaveText("Sign in");
    // A-03: the promise on the screen is plain and it is not a promise about money.
    await expect(page.getByText(/You drive the truck/i)).toBeVisible();
  });

  test("asks for a company name only when creating an account", async ({ page }) => {
    await installSupabaseStub(page);
    await page.goto("/auth");

    await expect(page.getByLabel("Company name")).toBeHidden();
    await modeTab(page, "Create account").click();
    await expect(page.getByLabel("Company name")).toBeVisible();
    await expect(submit(page)).toHaveText("Create account");
  });

  test("the primary button reports that it is working", async ({ page }) => {
    // The loading state is a done-when for this slice, and on a truck-stop connection it
    // is the difference between "it is thinking" and "it is broken, tap it again".
    await installSupabaseStub(page);
    await page.goto("/auth");

    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/auth/v1/token**", async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.getByLabel("Email").fill(EXISTING.email);
    await page.getByLabel("Password").fill("correct-horse");
    await submit(page).click();

    await expect(submit(page)).toHaveText(/Working/);
    release?.();
  });

  test("shows the server's reason when sign-in is refused, and stays on the form", async ({ page }) => {
    await installSupabaseStub(page);
    await page.route("**/auth/v1/token**", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials" }),
      }),
    );
    await page.goto("/auth");

    await page.getByLabel("Email").fill("nobody@example.test");
    await page.getByLabel("Password").fill("wrong-password");
    await submit(page).click();

    await expect(page.getByText(/Invalid login credentials|Could not sign in/i)).toBeVisible();
    await expect(page).toHaveURL(/\/auth/);
  });
});

test.describe("first login", () => {
  test("a brand-new account gets through the bootstrap and off the auth screen", async ({ page }) => {
    // The path the database suite found broken: the org insert used to come back refused
    // by its own SELECT policy, so sign-up dead-ended here for every new account.
    await installSupabaseStub(page, { firstLogin: true });
    await page.goto("/auth");

    await modeTab(page, "Create account").click();
    await page.getByLabel("Company name").fill("Freedom Trucking LLC");
    await page.getByLabel("Email").fill(EXISTING.email);
    await page.getByLabel("Password").fill("a-real-password");
    await submit(page).click();

    await expect(page).not.toHaveURL(/\/auth/, { timeout: 15_000 });
  });

  test("a returning account lands signed in, and the session survives a reload", async ({ page }) => {
    await installSupabaseStub(page);
    await page.goto("/auth");

    await page.getByLabel("Email").fill(EXISTING.email);
    await page.getByLabel("Password").fill("correct-horse");
    await submit(page).click();
    await expect(page).not.toHaveURL(/\/auth/, { timeout: 15_000 });

    const landed = page.url();
    await page.reload();
    // Persistence is a done-when: a driver who reloads must not be thrown back to the form.
    await expect(page).toHaveURL(landed);
  });
});
