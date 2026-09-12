// Lint fixture for P-1C-1 — every known spelling of "read the environment directly".
//
// Linted by tests/lint-rails.test.ts under the agents/skills override (via a
// virtual file path); every `// form:` line below MUST produce >= 1 error there.
// Never executed. Deliberately a .js file: `Bun` and `Deno` are undeclared here
// and must STAY undeclared — a `declare const Bun` to satisfy tsc would turn the
// global into a local and defeat the very rule this fixture exists to prove.
//
// Before P-1C-1, five of these eight passed the lint. Probed, not assumed.
export const a1 = process.env.X; // form: process.env (baseline, was already caught)
export const a2 = process["env"].X; // form: computed process["env"]
const { env } = process; export const a3 = env.X; // form: destructured { env } = process
export const a4 = Bun.env.X; // form: Bun.env
export const a5 = Deno.env.get("X"); // form: Deno.env.get (was already caught)
export const a6 = import.meta.env.X; // form: import.meta.env
const p = process; export const a7 = p.env.X; // form: aliased process
export const a8 = globalThis.process.env.X; // form: globalThis.process.env (was already caught)
