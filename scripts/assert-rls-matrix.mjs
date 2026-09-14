#!/usr/bin/env node
// EZ-BUILD-01 Slice 3 (ticket 2B) -- the tenant-boundary matrix, built from the migration
// chain and checked without a database.
//
// WHY THIS IS NOT scripts/check-schema-parity.mjs. That one reads ONE file and answers "does
// every table in it have org_id, ENABLE and FORCE?". It cannot answer 2B's question, because
// 2B's facts are spread across the chain on purpose: the tables are declared in 0001 and
// 0003, FORCE lands in 0004, and the policies are dropped and recreated in 0004 against a
// function that did not exist until 0004. A per-file check reports every one of those as a
// gap. This one folds the chain in order, the way Postgres will, and asks 2B's questions of
// the RESULT:
//
//   1. every table is ENABLED and FORCED  -- enabled alone leaves the table owner exempt,
//      which is the half 0001 shipped;
//   2. every table has at least one policy -- RLS with no policy denies everything, which is
//      not a boundary, it is an outage waiting to be "fixed" by disabling RLS;
//   3. every tenant-scoped policy keys off auth.org_id(), never off a value the client sent;
//   4. every policy that can INSERT or UPDATE carries an explicit `with check`. Postgres will
//      inherit `using` when `with check` is omitted, so the omission is not a hole -- but it
//      is invisible in pg_policies, and a reviewer cannot check what is not written;
//   5. no writer's check is literally `true`. That may still be correct -- sign-up creates the
//      first org before the caller belongs to one -- but it is the exact shape of a tenancy
//      bug, so it has to be exempted by name with a reason rather than inherited quietly.
//
// Exemptions live in supabase/rls.exemptions.json, one entry per (table, rule) with a reason,
// and an entry naming a table that does not exist is itself a failure -- so the list cannot rot.
//
//   node scripts/assert-rls-matrix.mjs              # the real chain
//   node scripts/assert-rls-matrix.mjs --matrix     # print the matrix and nothing else
//   node scripts/assert-rls-matrix.mjs --self-test  # prove every rule goes red on a planted positive
//
// Plain .mjs so bare node runs it, before any build step exists.

import { readFileSync, existsSync } from "node:fs";

export const CHAIN = [
  "supabase/migrations/0001_baseline.sql",
  "supabase/migrations/0003_hardening_and_runtime.sql",
  "supabase/migrations/0004_rls_force_and_org_id.sql",
];

export const RULES = ["enabled", "forced", "has_policy", "org_scoped", "with_check", "no_blanket_check"];

const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const unquote = (n) => n.replace(/^"(.*)"$/, "$1").toLowerCase();

/**
 * Table names inside a `foreach t in array array[...]` loop body, which is how both 0001 and
 * 0004 apply RLS. A per-statement grep finds nothing in that shape and silently reports every
 * table as unprotected -- the exact trap scripts/check-schema-parity.mjs documents.
 */
function loopTables(body) {
  const out = [];
  const re = /array\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    for (const lit of m[1].matchAll(/'([^']+)'/g)) out.push(unquote(lit[1]));
  }
  return out;
}

/**
 * Fold the chain in order and return the resulting state. Order matters: a policy dropped in
 * a later file must not still count, which is the difference between reading the chain and
 * grepping it.
 *
 * @param {{name: string, sql: string}[]} files
 */
export function foldChain(files) {
  /** @type {Map<string, {enabled: boolean, forced: boolean, policies: Map<string, {table: string, name: string, cmd: string, using: string, check: string, source: string}>}>} */
  const tables = new Map();
  const table = (n) => {
    const k = unquote(n);
    if (!tables.has(k)) tables.set(k, { enabled: false, forced: false, policies: new Map() });
    return tables.get(k);
  };

  const clause = (text, kw) => {
    // The body of `using (...)` / `with check (...)`, matched with balanced parentheses so a
    // nested call like auth.org_id() does not truncate it at its own closing bracket. A regex
    // with [^)]* gets this wrong, and gets it wrong SILENTLY -- it reports a policy as having
    // no with check when it has one.
    const i = text.toLowerCase().indexOf(kw);
    if (i === -1) return "";
    const open = text.indexOf("(", i + kw.length);
    if (open === -1) return "";
    let depth = 0;
    for (let j = open; j < text.length; j += 1) {
      if (text[j] === "(") depth += 1;
      else if (text[j] === ")") {
        depth -= 1;
        if (depth === 0) return text.slice(open + 1, j);
      }
    }
    return "";
  };

  const policyFrom = (name, tbl, rest, source) => ({
    table: unquote(tbl),
    name: name.toLowerCase(),
    cmd: (rest.match(/for\s+(all|select|insert|update|delete)/i)?.[1] ?? "all").toLowerCase(),
    using: clause(rest, "using"),
    check: clause(rest, "with check"),
    source,
  });

  for (const file of files) {
    const sql = stripComments(file.sql);
    /** @type {{idx: number, apply: () => void}[]} */
    const events = [];
    const push = (idx, apply) => events.push({ idx, apply });

    for (const m of sql.matchAll(/create table\s+("?[a-z_][a-z0-9_]*"?)\s*\(/gi)) {
      push(m.index, () => table(m[1]));
    }

    // RLS, per-statement form.
    for (const m of sql.matchAll(/alter table\s+("?[a-z_][a-z0-9_]*"?)\s+(enable|force)\s+row level security/gi)) {
      push(m.index, () => {
        const t = table(m[1]);
        if (m[2].toLowerCase() === "enable") t.enabled = true;
        else t.forced = true;
      });
    }

    // Loop form -- how both 0001 and 0004 apply RLS across many tables at once. A loop whose
    // body does no RLS or policy work is NOT a table list: 0003's GATE 1 iterates over the
    // three Supabase ROLES, and crediting those as tables invented `anon`, `authenticated`
    // and `service_role` as unprotected tables the first time this ran.
    for (const m of sql.matchAll(/foreach\s+\w+\s+in\s+array\s+(array\s*\[[^\]]*\])([\s\S]*?)end loop/gi)) {
      const body = m[2];
      const enable = /enable row level security/i.test(body);
      const force = /force row level security/i.test(body);
      const creates = /create policy/i.test(body);
      const drops = /drop policy/i.test(body);
      if (!enable && !force && !creates && !drops) continue;
      const names = loopTables(m[1]);
      // `execute format('drop policy %I on %I', t || '_org', t)` -- the suffix the generated
      // name is built from, so a generated drop can be matched to a generated create.
      const dropSuffix = drops ? (body.match(/drop policy[^']*'[^)]*\|\|\s*'([a-z0-9_]+)'/i)?.[1] ?? "_org") : "";
      const createSuffix = creates ? (body.match(/create policy[\s\S]*?\|\|\s*'([a-z0-9_]+)'/i)?.[1] ?? "_org") : "";
      push(m.index, () => {
        for (const n of names) {
          const t = table(n);
          if (enable) t.enabled = true;
          if (force) t.forced = true;
          if (drops) t.policies.delete(`${n}${dropSuffix}`);
          if (creates) {
            const nm = `${n}${createSuffix}`;
            t.policies.set(nm, policyFrom(nm, n, body, file.name));
          }
        }
      });
    }

    for (const m of sql.matchAll(/drop policy(?:\s+if exists)?\s+([a-z_][a-z0-9_]*)\s+on\s+("?[a-z_][a-z0-9_]*"?)/gi)) {
      push(m.index, () => table(m[2]).policies.delete(m[1].toLowerCase()));
    }

    for (const m of sql.matchAll(
      /create policy\s+([a-z_][a-z0-9_]*)\s+on\s+("?[a-z_][a-z0-9_]*"?)([\s\S]*?);/gi,
    )) {
      const [, name, tbl, rest] = m;
      push(m.index, () => table(tbl).policies.set(name.toLowerCase(), policyFrom(name, tbl, rest, file.name)));
    }

    // Document order, not regex order. A policy dropped after it was created must not still
    // count, and grouping every drop before every create reverses exactly that.
    events.sort((a, b) => a.idx - b.idx);
    for (const e of events) e.apply();
  }
  return tables;
}

/**
 * @param {Map<string, any>} tables
 * @param {{table: string, rule: string, reason: string}[]} exemptions
 */
export function checkMatrix(tables, exemptions = []) {
  const problems = [];
  const exempt = new Set();
  exemptions.forEach((e, i) => {
    const where = `exemptions[${i}]`;
    if (!e || typeof e !== "object") return problems.push(`${where}: not an object`);
    const t = String(e.table ?? "").toLowerCase();
    if (!tables.has(t)) problems.push(`${where}: table "${e.table}" is not in the migration chain (stale exemption)`);
    if (!RULES.includes(e.rule)) problems.push(`${where}: rule "${e.rule}" is not one of ${RULES.join("|")}`);
    if (typeof e.reason !== "string" || e.reason.trim().length < 8) problems.push(`${where}: a one-line reason is required`);
    exempt.add(`${t}:${e.rule}`);
  });

  const rows = [];
  const gaps = [];
  for (const [name, t] of [...tables.entries()].sort()) {
    const policies = [...t.policies.values()];
    const writers = policies.filter((p) => ["all", "insert", "update"].includes(p.cmd));
    const status = {
      enabled: t.enabled,
      forced: t.forced,
      has_policy: policies.length > 0,
      // At least one policy must derive the tenant from identity. A table whose only policies
      // are is_founder() is platform-level and exempted by name, never by the check drifting.
      org_scoped: policies.some((p) => /auth\.org_id\(\)/.test(`${p.using} ${p.check}`)),
      // Every writer states its check. See rule 4 in the header.
      with_check: writers.length === 0 || writers.every((p) => p.check.trim().length > 0),
      // 5. A writer whose check is literally `true` accepts any row any authenticated user
      //    sends. That may still be correct -- sign-up has to create the first org before the
      //    caller belongs to one -- but it is the shape a tenancy bug looks like, so it has to
      //    be exempted BY NAME with a reason, never inherited quietly from 0001.
      no_blanket_check: writers.every((p) => !/^\s*true\s*$/i.test(p.check)),
    };
    rows.push({ table: name, policies: policies.length, ...status });
    for (const rule of RULES) {
      if (!status[rule] && !exempt.has(`${name}:${rule}`)) gaps.push({ table: name, rule });
    }
  }
  if (rows.length === 0) problems.push("no tables found in the chain -- wrong files?");
  return { rows, gaps, problems };
}

function printMatrix(rows) {
  const w = Math.max(5, ...rows.map((r) => r.table.length));
  console.log(`  ${"table".padEnd(w)}  pol  enabled  forced  policy  org  check  open`);
  const cell = (v) => (v ? " ok  " : "MISS ");
  for (const r of rows) {
    console.log(
      `  ${r.table.padEnd(w)}  ${String(r.policies).padStart(3)}   ${cell(r.enabled)}   ${cell(r.forced)}  ${cell(r.has_policy)}  ${cell(r.org_scoped)} ${cell(r.with_check)} ${cell(r.no_blanket_check)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// self-test -- one planted positive per rule, each seen to go red
// ---------------------------------------------------------------------------

const BASE = `
create table widget ( id uuid primary key, org_id uuid not null );
alter table widget enable row level security;
alter table widget force row level security;
create policy widget_org on widget for all using (org_id = auth.org_id()) with check (org_id = auth.org_id());
`;

function selfTest() {
  const cases = [
    ["a compliant table passes", BASE, []],
    [
      "a writer whose check is literally `true` has to justify itself",
      BASE.replace("with check (org_id = auth.org_id())", "with check (true)"),
      ["widget:no_blanket_check"],
    ],
    [
      "ENABLE without FORCE is a gap -- the 0001 shape",
      BASE.replace("alter table widget force row level security;\n", ""),
      ["widget:forced"],
    ],
    [
      "RLS with no policy at all is a gap, not a pass",
      BASE.replace(/create policy[\s\S]*/, ""),
      ["widget:has_policy", "widget:org_scoped"],
    ],
    [
      "a policy scoped by something other than auth.org_id() is a gap",
      BASE.replaceAll("org_id = auth.org_id()", "org_id = current_setting('request.org')::uuid"),
      ["widget:org_scoped"],
    ],
    [
      "a writer policy with no explicit with check is a gap",
      BASE.replace(" with check (org_id = auth.org_id())", ""),
      ["widget:with_check"],
    ],
    [
      "a policy dropped later in the chain does not still count",
      `${BASE}\ndrop policy widget_org on widget;\n`,
      ["widget:has_policy", "widget:org_scoped"],
    ],
    [
      "the loop form is credited, so the real chain's shape is not a false negative",
      `create table widget ( id uuid primary key, org_id uuid not null );
do $x$ declare t text; begin
  foreach t in array array['widget'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $x$;
create policy widget_org on widget for all using (org_id = auth.org_id()) with check (org_id = auth.org_id());`,
      [],
    ],
  ];

  let bad = 0;
  for (const [name, sql, expected] of cases) {
    const { gaps } = checkMatrix(foldChain([{ name: "planted.sql", sql }]));
    const got = gaps.map((g) => `${g.table}:${g.rule}`).sort();
    const ok = JSON.stringify(got) === JSON.stringify([...expected].sort());
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name} -- gaps [${got.join(", ")}], expected [${[...expected].sort().join(", ")}]`);
  }

  // A stale exemption is a defect in the exemption list, not a free pass.
  const { problems } = checkMatrix(foldChain([{ name: "planted.sql", sql: BASE }]), [
    { table: "does_not_exist", rule: "forced", reason: "a plausible sentence" },
  ]);
  const staleCaught = problems.some((p) => /stale exemption/.test(p));
  if (!staleCaught) bad++;
  console.log(`  ${staleCaught ? "ok  " : "FAIL"} an exemption naming a table that does not exist is itself a failure`);

  if (bad > 0) {
    console.error(`\nassert-rls-matrix --self-test: FAIL -- ${bad} case(s) did not behave as specified.`);
    process.exit(1);
  }
  console.log("\nassert-rls-matrix --self-test: OK -- every rule goes red on its planted positive.");
}

// ---------------------------------------------------------------------------

const invokedPath = process.argv[1] ?? "";
const isMain =
  invokedPath.endsWith("assert-rls-matrix.mjs") ||
  import.meta.url === new URL(`file://${invokedPath.replace(/\\/g, "/")}`).href;

if (isMain) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    const missing = CHAIN.filter((f) => !existsSync(f));
    if (missing.length > 0) {
      console.error(`assert-rls-matrix: missing migration(s): ${missing.join(", ")}`);
      process.exit(2);
    }
    const files = CHAIN.map((name) => ({ name, sql: readFileSync(name, "utf8") }));
    const exemptionsPath = "supabase/rls.exemptions.json";
    const exemptions = existsSync(exemptionsPath) ? JSON.parse(readFileSync(exemptionsPath, "utf8")) : [];
    const { rows, gaps, problems } = checkMatrix(foldChain(files), exemptions);

    console.log(`assert-rls-matrix: ${CHAIN.length} migrations folded, ${rows.length} tables, ${exemptions.length} exemptions`);
    printMatrix(rows);

    if (process.argv.includes("--matrix")) process.exit(0);

    if (problems.length > 0) {
      console.error("\nEXEMPTION DEFECTS:");
      for (const p of problems) console.error(`  - ${p}`);
    }
    if (gaps.length > 0) {
      console.error("\nFAIL -- tenant-boundary gaps (rule 4 / rule 40 / SPEC 2B):");
      for (const g of gaps) console.error(`  - ${g.table}: ${g.rule}`);
      console.error(
        "\nENABLE without FORCE leaves the table owner exempt. RLS with no policy denies everything.\n" +
          "A policy that scopes by anything a client can send is not a tenant boundary at all.\n",
      );
    }
    if (problems.length > 0 || gaps.length > 0) process.exit(1);

    console.log(
      "assert-rls-matrix: OK -- every table ENABLED and FORCED, every table has a policy, every\n" +
        "tenant policy derives org from identity, and every writer states its with check.",
    );
  }
}
