/**
 * EZ-BUILD-02 — the browser suite.
 *
 * Slice 7 owns the full project (Chromium + WebKit, isolated identities per worker, the
 * seven TESTING-PLAN workflows). This is the start of it, stood up at Slice 1 because
 * Slices 1–4 each want a case and a runner added later always arrives after the screens
 * it was meant to check.
 *
 * 393x852 is the default because the phone IS the product (QUALITY-STANDARD: "the customer
 * on their phone is the judge"). Desktop is a second project rather than the baseline, so a
 * layout that only works wide cannot pass by accident.
 *
 * `bun run test:e2e` — deliberately NOT part of `bun run test`, for the same reason
 * `test:db` is not: the offline suite must stand up no service, and the 24/784 floor stays
 * a statement about the code.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env["E2E_PORT"] ?? 4173);

export default defineConfig({
  testDir: "./tests/e2e",
  // A test that is flaky is a test nobody believes. One retry locally to absorb a cold
  // first paint; CI gets two and reports the flake rather than hiding it.
  retries: process.env["CI"] ? 2 : 1,
  reporter: process.env["CI"] ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 393, height: 852 } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: `bun run dev --port ${PORT} --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
