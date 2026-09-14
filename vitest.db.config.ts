/**
 * EZ-BUILD-02 Slice 1 — the DATABASE suite's config. Separate from `vitest.config.ts`
 * on purpose, and the separation is the point.
 *
 * `bun run test` must stand up no service. These tests need a live PostgreSQL, so they
 * live behind `bun run test:db`, which starts a throwaway cluster
 * (`scripts/with-test-db.ts`), applies the real migration chain, runs this config against
 * it and tears it down. Two configs, two commands, one rule: the 24/784 floor is a
 * statement about the code and never about whether a database answered.
 *
 * `passWithNoTests` is false here for the same reason it is false there, and it matters
 * more here: these are the RLS tests. A run that collected nothing and reported green
 * would be reporting that the tenant boundary holds, having tested nothing at all.
 *
 * No `reporters: json` and no floor assertion — the floor file belongs to the offline
 * suite. This suite's count moves with how much of the schema is under test, and pinning
 * it would only create a second number to maintain.
 */
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    passWithNoTests: false,
    include: ["tests/db/**/*.test.ts"],
    // One cluster, one connection pool, shared by every file. Running these in parallel
    // against a single embedded Postgres buys nothing and makes a failure's cause
    // ambiguous — two tests interleaving on the same rows looks exactly like a policy
    // that does not hold.
    fileParallelism: false,
    // A cold `initdb` plus the whole chain is slower than a unit test and the default
    // 5s timeout trips on the first connection, not on anything real.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
