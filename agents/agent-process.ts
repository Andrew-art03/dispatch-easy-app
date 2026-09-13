/**
 * "This process is an agent." — TICKET 1F item 1 (finding C-2).
 *
 * Importing this module declares it. That is the whole module; there is no
 * function to call and nothing to configure, so there is nothing to get wrong
 * at a call site and nothing an environment variable can switch off.
 *
 * Every module under `agents/` that can run inside a long-lived agent process
 * imports this FIRST — before anything that could reach a database. Once the
 * declaration is in, `packages/config/env.ts` ranks it above `EZ_PROCESS_KIND`,
 * so `EZ_PROCESS_KIND=app` in an inherited environment can no longer turn off
 * the rule-40 check in `createDb()`. It trips the kill switch instead.
 *
 * Do not import this from `src/**`, from an Edge Function, or from anything
 * under `packages/**`. Those are the app and edge kinds and the shared config
 * they both load; declaring them agents would refuse them the prod clients they
 * are legitimately allowed to hold.
 *
 * 1F/N-1: the line above used to end "`bun run check:agent-imports` fails if
 * this module is reachable from the web app's import graph", and that was FALSE
 * when it was written — the script had `AGENT_ROOTS = ["agents"]` and one
 * forbidden package, and nothing looked in this direction at all. It is true
 * now: `checkAppImports()` walks `src/`, `supabase/functions/` and `packages/`
 * and fails on any path that reaches this file, with its own planted positive in
 * the script's self-test and in tests/agent-imports.test.ts.
 *
 * The claim cost something real before it was checked. `packages/config/db.ts`
 * reached here through `agents/secrets.ts`, so the one sanctioned client factory
 * declared every process that used it an agent.
 */

import { declareProcessKind } from "../packages/config/process-kind.ts";

declareProcessKind("agent", "agents/agent-process.ts");

/**
 * Exported only so a linter, a bundler or a future `verbatimModuleSyntax` pass
 * cannot treat this as an unused side-effect import and drop it. Importing the
 * module is what matters; the value is inert.
 */
export const AGENT_PROCESS_DECLARED = true;
