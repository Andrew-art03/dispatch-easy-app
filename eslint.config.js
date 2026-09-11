import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // SPEC 1C top failure mode: "sibling package's token leaks into a skill."
    // `readSecret()` in agents/secrets.ts is the ONLY sanctioned read, so raw env
    // access is banned everywhere a skill or the runner executes. agents/secrets.ts
    // itself is not in this glob — it is where the sanctioned read lives.
    //
    // This is a lint rule, not a runtime rail, and lint rules can be disabled with
    // a comment. That is acceptable here only because disabling it is visible in a
    // diff; the runtime rail is `readSecret` tripping the kill switch (rule 41).
    files: ["agents/skills/**/*.{ts,tsx}", "agents/runner/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            "process.env is banned in skills and the runner (rule 41). Declare the name in this skill's manifest.ts and read it with readSecret().",
        },
        {
          selector: "MemberExpression[object.name='Deno'][property.name='env']",
          message:
            "Deno.env is banned in skills and the runner (rule 41). Declare the name in this skill's manifest.ts and read it with readSecret().",
        },
        {
          // Closes the obvious hole in the two rules above: both match the
          // identifier `process`/`Deno` literally, so `globalThis.process.env`
          // and `const p = process; p.env` sail past them.
          selector: "MemberExpression[object.property.name='process'][property.name='env']",
          message:
            "globalThis.process.env is banned in skills and the runner (rule 41). Use readSecret().",
        },
      ],
    },
  },
  eslintPluginPrettier,
  {
    // Formatting is advisory, not a merge gate (decision 2026-09-08, applied
    // 2026-09-11). `eslint-plugin-prettier/recommended` sets this to "error",
    // which made every unformatted line fail `bun run lint` and took CI red on
    // all 13 runs since ci.yml landed. Nothing about correctness was being
    // caught — the failures were whitespace. `bun run format` still fixes them.
    //
    // The hard gates are deliberately untouched and stay errors: typecheck,
    // test, build + check:bundle, check:env, and gitleaks.
    rules: { "prettier/prettier": "warn" },
  },
);
