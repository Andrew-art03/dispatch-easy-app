/**
 * TICKET 1F item 2 — the import-graph gate, run as part of the suite.
 *
 * Why here as well as in `scripts/assert-agent-imports.mjs`: the script needs a
 * line in `.github/workflows/ci.yml` to run in CI, and this session's token is
 * scoped to Contents + Pull requests with no `workflow` scope (rule 27 — an
 * agent does not hold a credential that can rewrite its own CI). `bun run test`
 * is already a CI step, so putting the walk in the suite makes the gate real on
 * the next PR run instead of real whenever Andrew gets to the workflow file.
 * The script stays, for local use and for the ci.yml line when it lands.
 *
 * The cases below are not a re-test of the script's own self-test. They are the
 * two things a reviewer wants pinned: that THIS repo is clean right now, and
 * that the gate is not vacuous — it has an entrypoint set that is not empty, and
 * it goes red on the positive the ticket names.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error — .mjs gate script, no type declarations; it is plain JS on purpose
// so CI can run it with bare node, before any build step exists.
import { checkAgentImports, checkAppImports } from "../scripts/assert-agent-imports.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Violation = { chain: string[]; specifier: string };
type Result = { entries: string[]; violations: Violation[] };

const check = (root: string): Result => checkAgentImports(root) as Result;
/** N-1: the same walk in the other direction — app/edge/shared -> the agent declaration. */
const checkApp = (root: string): Result => checkAppImports(root) as Result;

describe("rule 40 structurally: no agent module can reach a Supabase client", () => {
  it("this repo has no path from agent code to @supabase/supabase-js", () => {
    const { violations } = check(REPO_ROOT);
    // Printed as chains so a failure names the hop that introduced it, not just
    // the entrypoint that happens to sit at the top of it.
    expect(violations.map((v) => [...v.chain, v.specifier].join(" -> "))).toEqual([]);
  });

  it("is not vacuous — there are agent modules and they are actually walked", () => {
    // A gate that finds nothing to check is a gate that passes for the wrong
    // reason. C-1 was filed as lint debt for three days; a silently empty
    // entrypoint set is how a fix goes the same way.
    const { entries } = check(REPO_ROOT);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).toContain("agents/guardrails.ts");
    expect(entries).toContain("agents/actions.ts");
    expect(entries).toContain("agents/secrets.ts");
    expect(entries).toContain("agents/agent-process.ts");
  });

  it("excludes test files from the roots, since a test harness is not an agent process", () => {
    const { entries } = check(REPO_ROOT);
    expect(entries).not.toContain("agents/wall.test.ts");
  });
});

describe("the gate goes red on a planted positive", () => {
  let dir: string;

  const write = (relPath: string, body: string) => {
    mkdirSync(dirname(join(dir, relPath)), { recursive: true });
    writeFileSync(join(dir, relPath), body);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ez-agent-imports-vitest-"));
    write(
      "src/lib/supabase.ts",
      // db-boundary:allow — planted fixture, written to a temp dir and never to this tree.
      `import { createClient } from "@supabase/supabase-js";\nexport const supabase = createClient("u", "k");\n`,
    );
    write("agents/innocent.ts", `export const x = 1;\n`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is green while no agent module reaches the client", () => {
    expect(check(dir).violations).toEqual([]);
  });

  it("fails on the ticket's positive: an agent file importing src/lib/supabase.ts", () => {
    write("agents/planted.ts", `import { supabase } from "../src/lib/supabase.ts";\nexport const y = supabase;\n`);
    const { violations } = check(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.chain).toEqual(["agents/planted.ts", "src/lib/supabase.ts"]);
    expect(violations[0]?.specifier).toBe("@supabase/supabase-js");
  });

  it("fails through a re-export, where the agent names neither the package nor the client", () => {
    // The case that makes this a graph walk rather than a grep. Nothing in
    // agents/planted.ts contains the string "supabase-js" or "createClient".
    write("src/lib/data.ts", `export { supabase as client } from "./supabase.ts";\n`);
    write("agents/planted.ts", `import { client } from "../src/lib/data.ts";\nexport const y = client;\n`);
    const { violations } = check(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.chain).toEqual([
      "agents/planted.ts",
      "src/lib/data.ts",
      "src/lib/supabase.ts",
    ]);
  });

  it("fails through the guarded factory too — createDb() is still a client constructor", () => {
    // An agent that can import the safe factory can construct a client, and the
    // only thing then standing between it and prod is a runtime check. 1F item 1
    // hardened that check; this is the layer that removes the need to rely on it.
    write(
      "packages/config/db.ts",
      // db-boundary:allow — planted fixture, written to a temp dir and never to this tree.
      `import { createClient } from "@supabase/supabase-js";\nexport const createDb = () => createClient("u", "k");\n`,
    );
    write("agents/planted.ts", `import { createDb } from "../packages/config/db.ts";\nexport const y = createDb;\n`);
    expect(check(dir).violations).toHaveLength(1);
  });

  it("reports every offending entrypoint, not just the first", () => {
    write("agents/planted-a.ts", `import { supabase } from "../src/lib/supabase.ts";\nexport const a = supabase;\n`);
    write("agents/planted-b.ts", `import { supabase } from "../src/lib/supabase.ts";\nexport const b = supabase;\n`);
    expect(check(dir).violations).toHaveLength(2);
  });

  it("fails closed on an unresolvable relative import rather than skipping it", () => {
    write("agents/planted.ts", `import { gone } from "./does-not-exist.ts";\nexport const y = gone;\n`);
    expect(() => check(dir)).toThrow(/cannot resolve/);
  });
});

// ---------------------------------------------------------------------------
// N-1 — the OTHER direction, which nothing checked
// ---------------------------------------------------------------------------

/**
 * The gate above walks agent code and asks "can it reach a database client?".
 * `agents/agent-process.ts` claimed in its own header that `check:agent-imports`
 * "fails if this module is reachable from the web app's import graph". That was
 * false: `AGENT_ROOTS = ["agents"]` and one forbidden PACKAGE — nothing looked
 * the other way at all.
 *
 * It matters because importing `agents/agent-process.ts` is not inert. It runs
 * `declareProcessKind("agent")` at module init, permanently, for the whole
 * process. So an app, an Edge Function or the shared client factory that reaches
 * it becomes an agent process by accident — and then either trips `process_kind`
 * against its own `EZ_PROCESS_KIND=app` opt-out, or resolves as an agent and
 * trips `prod_target` on a production client it is legitimately allowed to hold.
 *
 * That is a direction rule, and a direction rule has to be checked in its own
 * direction.
 */
describe("N-1: app, edge and shared config must not reach the agent declaration", () => {
  it("this repo has no path from an app/edge/shared root to agents/agent-process.ts", () => {
    const { violations } = checkApp(REPO_ROOT);
    expect(violations.map((v) => [...v.chain, v.specifier].join(" -> "))).toEqual([]);
  });

  it("is not vacuous — the client factory and the app entry are among the roots walked", () => {
    // The same lesson as the gate above: a direction rule whose root set is
    // empty passes for the wrong reason. `packages/config/db.ts` is named
    // explicitly because it is the file N-1 was actually about.
    const { entries } = checkApp(REPO_ROOT);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).toContain("packages/config/db.ts");
    expect(entries).toContain("packages/config/env.ts");
  });
});

describe("N-1: the direction rule goes red on a planted violation", () => {
  let dir: string;

  const write = (relPath: string, body: string) => {
    mkdirSync(dirname(join(dir, relPath)), { recursive: true });
    writeFileSync(join(dir, relPath), body);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ez-app-imports-vitest-"));
    write("agents/agent-process.ts", `export const AGENT_PROCESS_DECLARED = true;\n`);
    write("src/main.ts", `export const app = 1;\n`);
    write("packages/config/db.ts", `export const createDb = () => 1;\n`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is green while nothing on the app side names it", () => {
    expect(checkApp(dir).violations).toEqual([]);
  });

  it("fails on the N-1 shape itself: the shared factory importing it, two hops away", () => {
    // Exactly what HEAD does — db.ts imports agents/secrets.ts for the
    // registry, and agents/secrets.ts declares the process an agent on import.
    write("agents/secrets.ts", `import "./agent-process.ts";\nexport const registerSecretValue = () => undefined;\n`);
    write(
      "packages/config/db.ts",
      `import { registerSecretValue } from "../../agents/secrets.ts";\nexport const createDb = () => registerSecretValue();\n`,
    );
    const { violations } = checkApp(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.chain).toEqual(["packages/config/db.ts", "agents/secrets.ts"]);
    expect(violations[0]?.specifier).toBe("agents/agent-process.ts");
  });

  it("fails on a direct import from src/", () => {
    write("src/main.ts", `import "../agents/agent-process.ts";\nexport const app = 1;\n`);
    const { violations } = checkApp(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.chain).toEqual(["src/main.ts"]);
  });

  it("fails on an Edge Function reaching it, since Deno code is the edge kind", () => {
    write("supabase/functions/hello/index.ts", `import "../../../agents/agent-process.ts";\nexport const h = 1;\n`);
    expect(checkApp(dir).violations).toHaveLength(1);
  });

  it("does not flag agent code itself — agents/** is supposed to declare", () => {
    write("agents/guardrails.ts", `import "./agent-process.ts";\nexport const g = 1;\n`);
    expect(checkApp(dir).violations).toEqual([]);
  });
});
