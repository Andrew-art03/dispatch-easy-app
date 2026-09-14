/**
 * EZ-BUILD-01 Slice 1 — the first vitest config in this repo.
 *
 * WHY IT EXISTS AT ALL. Until now `vitest run` fell through to `vite.config.ts`,
 * which is `@lovable.dev/vite-tanstack-config` — the whole TanStack Start / nitro
 * / tailwind plugin chain, built for serving the web app, loaded to run a suite
 * that never renders a component. Two things follow from that, and both are
 * defects this file closes.
 *
 * 1. `passWithNoTests` was left at its default. A test file that collects ZERO
 *    tests reported green exactly like one that collects sixteen. That is not
 *    hypothetical: `tests/agent-imports.test.ts` IS 1F's import-graph gate, the
 *    thing that makes "an agent can never construct a database client"
 *    structural rather than a promise, and it has been collecting zero.
 *    (BUILD_DEFAULTS R-2.)
 *
 * 2. Vite's transform pipeline does not run over `.mjs`, so a hashbang survives
 *    into the module the runner evaluates and V8 rejects `#` as an invalid
 *    token. Every rail script in `scripts/` opens `#!/usr/bin/env node`. Node
 *    strips a hashbang; the runner does not. That is the actual, measured cause
 *    of the `agent-imports` failure recorded in DIRECTOR-HANDOVER §5 — not the
 *    1F merge, which changed no config file at all:
 *
 *      git diff e58d336 19e7908 -- package.json tsconfig.json vite.config.ts \
 *          bunfig.toml bun.lock eslint.config.js        ->  empty
 *
 *    The fix belongs in the harness. The gate script is untouched (it still has
 *    to be executable by bare node, before any build step exists) and the test
 *    file is untouched.
 *
 * A vitest config SUPERSEDES vite.config.ts rather than merging with it, so the
 * plugin chain leaves the test environment. Nothing under `tests/` or `agents/`
 * imports `@/…` or any real `src/**` module — checked by grep before this landed
 * — and the `@` alias is declared below anyway so a later slice's server code
 * does not trip over its absence. The proof that this is inert is the collected
 * file and test count, which must not move down. Ever.
 */
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Replaces a leading `#!` with `//` — same byte length, so every offset,
 * line and column in the file is preserved and no source map is needed.
 * Scoped to first-party `.js`/`.mjs`; `node_modules` is left alone.
 */
const stripHashbang = {
  name: "ez-strip-hashbang",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (id.includes("node_modules")) return null;
    if (!/\.m?js(\?|$)/.test(id)) return null;
    if (!code.startsWith("#!")) return null;
    return { code: `//${code.slice(2)}`, map: null };
  },
};

export default defineConfig({
  plugins: [stripHashbang],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // R-2: a file that collects nothing is a FAILURE, not a pass.
    passWithNoTests: false,
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.output/**",
      "**/.tanstack/**",
      "**/.vinxi/**",
      "**/.nitro/**",
      // EZ-BUILD-02 Slice 1: `tests/db/**` needs a live PostgreSQL and runs under
      // `vitest.db.config.ts` via `bun run test:db`. It is excluded HERE, not merely
      // absent from a list somewhere, because this config's include is a `**` glob —
      // adding a file under tests/db/ would otherwise silently make `bun run test`,
      // and with it the 24/784 floor, depend on a database being reachable. A floor
      // that goes red because a port was busy teaches people to ignore red.
      "tests/db/**",
    ],
    // The JSON report is what `scripts/assert-test-floor.mjs` reads to hold the
    // floor. Written on every run so the gate can never be "forgotten" by a
    // caller that omitted a flag.
    reporters: ["default", "json"],
    outputFile: { json: ".vitest/results.json" },
  },
});
