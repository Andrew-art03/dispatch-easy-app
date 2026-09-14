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
      // P-1C-1 (panel pass, 2026-09-11): the selector rules below match SHAPES,
      // and a shape can be rewritten. Probed before this change, all of these
      // passed the lint: `process["env"]`, `const { env } = process`, `Bun.env`,
      // `import.meta.env`, `const p = process; p.env`. Banning the GLOBALS
      // catches every spelling that starts from the identifier at all —
      // computed, destructured, aliased — because the reference itself is the
      // violation. No skill has a legitimate use for any of these three.
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message:
            "`process` is banned in skills and the runner in every form (rule 41). Declare the name in this skill's manifest.ts and read it with readSecret().",
        },
        {
          name: "Bun",
          message: "`Bun` (and Bun.env) is banned in skills and the runner (rule 41). Use readSecret().",
        },
        {
          name: "Deno",
          message: "`Deno` (and Deno.env) is banned in skills and the runner (rule 41). Use readSecret().",
        },
      ],
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
        // P-1C-1: the three shapes no-restricted-globals cannot see, because they
        // never reference `process`/`Bun`/`Deno` as an identifier — plus two it
        // can, kept as belt-and-braces so a future config edit that drops the
        // globals rule does not silently reopen them.
        {
          selector: "MemberExpression[object.type='MetaProperty'][property.name='env']",
          message:
            "import.meta.env is banned in skills and the runner (rule 41). VITE_* is the browser's surface, not a skill's. Use readSecret().",
        },
        {
          selector: "MemberExpression[computed=true][property.value='env']",
          message:
            "Computed access to `env` (process[\"env\"]) is banned in skills and the runner (rule 41). Use readSecret().",
        },
        {
          selector: "VariableDeclarator[id.type='ObjectPattern'][init.name='process']",
          message:
            "Destructuring `process` (const { env } = process) is banned in skills and the runner (rule 41). Use readSecret().",
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
