/**
 * EZ-BUILD-01 Slice 9 (ticket 6E) — the append-only ledger, the week, and the leak detector.
 *
 * SPEC 6E's "done when" is two clauses, and both are about the grant layer rather than about
 * code being careful:
 *
 *   a direct insert attempt fails                 -> revoked from authenticated, anon AND
 *                                                    service_role, so there is no caller left
 *   the approved path succeeds once, single-use   -> consume_approval is the first statement,
 *                                                    and it is atomic
 *
 * Both live in SQL, so both are asserted on the migration text — the same way Slices 2, 3 and 6
 * assert theirs, and with the same limitation stated up front: nothing here has been applied to
 * a database (D-CC-1). The pure half — the week arithmetic and the leak detector — is exercised
 * directly, in integer cents, with no clock anywhere.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COLLECTED_LABEL,
  ESTIMATED_LABEL,
  type LedgerLine,
  detectLeaks,
  formatCents,
  settlementOf,
  weekSummary,
} from "../packages/domain/week.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(`${REPO_ROOT}${rel}`, "utf8");

const SQL = read("supabase/migrations/0006_ledger_and_approved_action.sql");
const CODE = SQL.replace(/--[^\n]*/g, "");
const at = (needle: string) => {
  const i = CODE.indexOf(needle);
  return i === -1 ? Number.POSITIVE_INFINITY : i;
};

const WEEK = { from: "2026-09-07T00:00:00.000Z", to: "2026-09-14T00:00:00.000Z" };

const line = (over: Partial<LedgerLine> = {}): LedgerLine => ({
  id: "l1",
  loadId: "load-1",
  category: "revenue",
  amountCents: 280000,
  collectedCents: 0,
  source: "rate_con",
  at: "2026-09-09T12:00:00.000Z",
  ...over,
});

describe("SPEC 6E clause 1 — a direct insert cannot succeed, for anybody", () => {
  it("insert on ledger_line is revoked from all three roles (0003)", () => {
    const m0003 = read("supabase/migrations/0003_hardening_and_runtime.sql").replace(/--[^\n]*/g, "");
    expect(m0003).toMatch(/revoke insert on ledger_line from authenticated, anon, service_role;/);
  });

  it("and update/delete too, so a written line cannot be edited afterwards", () => {
    const m0003 = read("supabase/migrations/0003_hardening_and_runtime.sql").replace(/--[^\n]*/g, "");
    expect(m0003).toMatch(/revoke update, delete on ledger_line from authenticated, anon;/);
  });

  it("the only insert on ledger_line in the whole repo is inside execute_approved_action", () => {
    // Not "the only one we wrote" — the only one there is. If a second appears, this fails
    // before anybody has to notice it in review.
    const migrations = ["0001_baseline.sql", "0003_hardening_and_runtime.sql", "0004_rls_force_and_org_id.sql", "0005_transition_load.sql", "0006_ledger_and_approved_action.sql"];
    let total = 0;
    for (const m of migrations) {
      const sql = read(`supabase/migrations/${m}`).replace(/--[^\n]*/g, "");
      total += (sql.match(/insert into ledger_line/gi) ?? []).length;
    }
    expect(total).toBe(1);
    expect(at("insert into ledger_line")).toBeGreaterThan(at("function execute_approved_action"));
  });

  /**
   * ONE recorded offender, named rather than counted — the same treatment C-3 gets in
   * tests/db-boundary.test.ts, and for the same reason: if this fails with MORE than the list,
   * a new file started writing money directly. If it fails with FEWER, the offender was fixed —
   * delete the entry, do not widen the list.
   *
   * `src/components/AddExpense.tsx` inserts into `ledger_line` with the user's JWT. It is a
   * front-end file, `src/**` is out of this ticket's scope (BUILD_DEFAULTS §2), and the fix is
   * a product decision rather than a builder's — expenses have no approved-action path yet, and
   * inventing one would be inventing a product. Three separate findings, all in D-CC-5.
   */
  const KNOWN_TS_LEDGER_WRITERS = ["src/components/AddExpense.tsx"];

  it("no TypeScript writes a ledger line, apart from the one recorded offender", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(`${REPO_ROOT}${dir}`)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const rel = `${dir}/${entry}`;
        if (statSync(`${REPO_ROOT}${rel}`).isDirectory()) walk(rel, out);
        else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(rel);
      }
      return out;
    };
    const files = [...walk("src"), ...walk("supabase/functions"), ...walk("packages"), ...walk("agents")];
    expect(files.length).toBeGreaterThan(50);

    const offenders = files.filter((f) => {
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      return /\.from\(\s*["']ledger_line["']\s*\)[\s\S]{0,200}?\.insert\(/.test(src);
    });
    expect(offenders.sort()).toEqual([...KNOWN_TS_LEDGER_WRITERS].sort());
  });

  it("that offender is ALREADY broken today, before any migration of mine", () => {
    // It omits org_id on the stated belief that a database default fills it in. There is no
    // such default: ledger_line.org_id is `not null` with no default, and no table in the
    // frozen schema defaults org_id to current_org_id(). So the insert cannot ever have
    // succeeded — it violates NOT NULL. Pinned here so the claim is checkable rather than
    // asserted in a report.
    const src = read("src/components/AddExpense.tsx");
    expect(src).toContain('.from("ledger_line").insert({');
    expect(src).toMatch(/org_id is filled by the database default/);
    const schema = read("supabase/schema.sql");
    const table = schema.slice(schema.indexOf("create table ledger_line"));
    expect(table.slice(0, table.indexOf(");"))).toMatch(/org_id uuid not null references org\(id\)/);
    expect(schema).not.toContain("default current_org_id()");
  });

  it("and it forms a float on the money path, which R-4 forbids", () => {
    // `Number(amount)` on a text input, then `-Math.abs(value)`. A float has been formed before
    // the value ever reaches the database, which is the parse R-4 names explicitly.
    const src = read("src/components/AddExpense.tsx");
    expect(src).toMatch(/Number\(amount\)/);
    expect(src).toMatch(/amount: -Math\.abs\(value\)/);
  });
});

describe("SPEC 6E clause 2 — the approved path succeeds once, and is single-use", () => {
  it("O-1 is closed: the function and its grant land in the same migration", () => {
    // 0003 granted execute on a function whose body was deferred, which would have aborted the
    // whole migration. Option (ii) said both land together. They do, here.
    expect(at("function execute_approved_action")).toBeLessThan(
      at("grant execute on function execute_approved_action"),
    );
    const m0003 = read("supabase/migrations/0003_hardening_and_runtime.sql").replace(/--[^\n]*/g, "");
    expect(m0003).not.toMatch(/grant execute on function execute_approved_action/);
  });

  it("consume_approval is the FIRST thing that happens, before any write", () => {
    // Nothing is written before the human's authorisation has been spent. If the order were the
    // other way round, a refused approval would leave ledger rows behind.
    expect(at("consume_approval(p_approval")).toBeLessThan(at("insert into ledger_line"));
    expect(at("consume_approval(p_approval")).toBeLessThan(at("perform transition_load"));
  });

  it("zero rows from consume_approval raises, rather than continuing", () => {
    expect(CODE).toMatch(/if v_approval\.id is null then[\s\S]{0,300}?raise exception/);
  });

  it("the refusal does not say WHICH reason it was", () => {
    // Expired, already used, terms drifted and wrong tenant are all the same answer: no. Telling
    // the caller which one leaks the existence and state of somebody's approval.
    const msg = CODE.slice(at("approval refused"), at("approval refused") + 160);
    expect(msg).toMatch(/expired, already used, terms changed, or not this tenant/);
  });

  it("the tenant on the ledger line comes from the APPROVAL, not from the caller's claim", () => {
    expect(CODE).toMatch(/v_approval\.org_id,\s*$/m);
  });

  it("the transition happens in the same transaction, so a rollback un-spends the approval", () => {
    expect(CODE).toContain("perform transition_load(");
    expect(CODE).not.toMatch(/\bcommit\b/i);
  });

  it("execute is granted to authenticated and revoked from public and anon", () => {
    expect(CODE).toMatch(/revoke execute on function execute_approved_action\(uuid, jsonb\) from public, anon;/);
    expect(CODE).toMatch(/grant execute on function execute_approved_action\(uuid, jsonb\) to authenticated;/);
  });

  it("consume_approval itself is still callable by nobody", () => {
    // Otherwise the single-use gate could be spent on its own and the result ignored.
    const m0003 = read("supabase/migrations/0003_hardening_and_runtime.sql").replace(/--[^\n]*/g, "");
    expect(m0003).toMatch(/revoke execute on function consume_approval\(uuid, text, uuid, text\)/);
  });
});

describe("R-4 on the money path: integer cents, and a non-integer is refused", () => {
  it("the ledger's authoritative column is integer cents", () => {
    expect(CODE).toContain("alter table ledger_line add column amount_cents bigint");
    expect(CODE).toMatch(/alter column amount_cents set not null/);
  });

  it("a non-integer amount_cents raises rather than being rounded", () => {
    // Rounding somebody's money to taste is the failure R-4 exists to prevent.
    expect(CODE).toMatch(/amount_cents'\) !~ '\^-\?\[0-9\]\+\$'/);
    expect(CODE).toMatch(/raise exception 'execute_approved_action: amount_cents must be an integer/);
  });

  it("the legacy numeric column is written from the integer, in exact numeric", () => {
    // `numeric` is exact in Postgres; the float only appears on the trip out to JavaScript.
    // So `amount` is a display copy derived from the authoritative integer, never the reverse.
    expect(CODE).toContain("v_cents::numeric / 100");
  });

  it("formatCents formats from the integer and refuses a non-integer", () => {
    expect(formatCents(280000)).toBe("$2,800.00");
    expect(formatCents(2805)).toBe("$28.05");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(-7500)).toBe("-$75.00");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(() => formatCents(28.5)).toThrow(/integer cents/);
  });
});

describe("R-7: collected is owned by the ledger, and settlement is DERIVED", () => {
  it("collected_cents is a column on the line, and no status column exists", () => {
    expect(CODE).toContain("alter table ledger_line add column collected_cents bigint not null default 0");
    // A stored status is a status that can disagree with the rows it claims to summarise.
    expect(CODE).not.toMatch(/add column settlement/i);
    expect(CODE).not.toMatch(/add column .*status/i);
  });

  it("the database derives it in a function, not from a column", () => {
    expect(CODE).toMatch(/create or replace function load_settlement\(p_load uuid\)/);
    expect(CODE).toContain("'PARTIAL'");
    expect(CODE).toContain("from ledger_line");
  });

  it("collected can never exceed what was billed on the line", () => {
    expect(CODE).toContain("ledger_line_collected_within_amount");
    expect(CODE).toContain("ledger_line_collected_not_negative");
  });

  it("the TypeScript derivation agrees with the SQL's four cases", () => {
    expect(settlementOf([])).toBe("NO_REVENUE");
    expect(settlementOf([line({ amountCents: -5000, collectedCents: 0 })])).toBe("NO_REVENUE");
    expect(settlementOf([line({ collectedCents: 0 })])).toBe("UNSETTLED");
    expect(settlementOf([line({ collectedCents: 100000 })])).toBe("PARTIAL");
    expect(settlementOf([line({ collectedCents: 280000 })])).toBe("SETTLED");
  });

  it("a cost line does not make a load look settled", () => {
    // Only positive lines are revenue. Netting a cost against the billed figure would let a
    // fuel receipt mark a load collected.
    expect(settlementOf([line({ amountCents: 280000 }), line({ id: "l2", amountCents: -80000, category: "fuel" })])).toBe(
      "UNSETTLED",
    );
  });
});

describe("the week: two numbers, kept apart", () => {
  const lines: LedgerLine[] = [
    line({ id: "a", amountCents: 280000, collectedCents: 280000, at: "2026-09-08T00:00:00.000Z" }),
    line({ id: "b", amountCents: 150000, collectedCents: 0, at: "2026-09-10T00:00:00.000Z" }),
    line({ id: "c", amountCents: -60000, collectedCents: 0, category: "fuel", at: "2026-09-10T00:00:00.000Z" }),
    // Outside the window on both sides.
    line({ id: "d", amountCents: 999999, collectedCents: 999999, at: "2026-09-06T23:59:59.999Z" }),
    line({ id: "e", amountCents: 999999, collectedCents: 999999, at: "2026-09-14T00:00:00.000Z" }),
  ];

  it("counts only the lines inside the window — `from` inclusive, `to` exclusive", () => {
    const w = weekSummary(lines, WEEK);
    expect(w.lineCount).toBe(3);
    expect(w.billedCents).toBe(430000);
    expect(w.costsCents).toBe(60000);
  });

  it("billed and collected are separate figures, never merged", () => {
    const w = weekSummary(lines, WEEK);
    expect(w.billedCents).toBe(430000);
    expect(w.collectedCents).toBe(280000);
    expect(w.estimatedNetCents).toBe(430000 - 60000);
    expect(w.collectedNetCents).toBe(280000 - 60000);
    expect(w.estimatedNetCents).not.toBe(w.collectedNetCents);
  });

  it("carries its own labels, so a caller cannot relabel an estimate as a payment", () => {
    const w = weekSummary(lines, WEEK);
    expect(w.labels.estimated).toBe(ESTIMATED_LABEL);
    expect(w.labels.collected).toBe(COLLECTED_LABEL);
    expect(ESTIMATED_LABEL).toBe("Estimated net (before tax)");
    expect(COLLECTED_LABEL).toBe("Collected so far");
  });

  it("every figure is an integer number of cents", () => {
    const w = weekSummary(lines, WEEK);
    for (const v of [w.billedCents, w.collectedCents, w.costsCents, w.estimatedNetCents, w.collectedNetCents]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("breaks down by category, so a wrong week can be read rather than guessed at", () => {
    const w = weekSummary(lines, WEEK);
    expect(w.byCategory["revenue"]).toEqual({ billedCents: 430000, collectedCents: 280000 });
    expect(w.byCategory["fuel"]).toEqual({ billedCents: -60000, collectedCents: 0 });
  });

  it("an empty week is zero and NO_REVENUE, not an error", () => {
    const w = weekSummary([], WEEK);
    expect(w.billedCents).toBe(0);
    expect(w.settlement).toBe("NO_REVENUE");
  });

  it("takes the week boundary as an argument — it never asks what day it is", () => {
    const src = read("packages/domain/week.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/Date\.now\(|new Date\(/);
    // A weekly figure a driver cannot reproduce tomorrow is a weekly figure a driver will not trust.
    const a = weekSummary(lines, WEEK);
    const b = weekSummary(lines, WEEK);
    expect(a).toEqual(b);
  });
});

describe("the leak detector reports, and does not act", () => {
  it("finds money billed and not collected", () => {
    const leaks = detectLeaks({
      loadId: "load-1",
      lines: [line({ amountCents: 280000, collectedCents: 100000 })],
      estimatedNetCents: null,
    });
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ kind: "uncollected", cents: 180000 });
    expect(leaks[0]?.note).toContain("$1,800.00");
  });

  it("finds an agreed accessorial that never reached the ledger — the classic leak", () => {
    // Detention that was earned, agreed, and never billed is the thing this product exists to
    // notice.
    const leaks = detectLeaks({
      loadId: "load-1",
      lines: [line({ amountCents: 280000, collectedCents: 280000 })],
      estimatedNetCents: null,
      agreedAccessorialsCents: { detention: 15000 },
    });
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ kind: "missing_accessorial", category: "detention", cents: 15000 });
    expect(leaks[0]?.note).toContain("does not appear on the ledger at all");
  });

  it("finds a partly-billed accessorial too, and says which it is", () => {
    const leaks = detectLeaks({
      loadId: "load-1",
      lines: [line({ amountCents: 280000, collectedCents: 280000 }), line({ id: "l2", category: "detention", amountCents: 5000, collectedCents: 5000 })],
      estimatedNetCents: null,
      agreedAccessorialsCents: { detention: 15000 },
    });
    expect(leaks[0]).toMatchObject({ kind: "missing_accessorial", cents: 10000 });
    expect(leaks[0]?.note).toContain("less detention was billed than the deal agreed");
  });

  it("flags an estimate above the ledger WITHOUT claiming anything is owed", () => {
    // The estimate could simply have been optimistic. Saying "owed" would be a promise, and the
    // product estimates rather than promises (R-10).
    const leaks = detectLeaks({
      loadId: "load-1",
      lines: [line({ amountCents: 200000, collectedCents: 200000 })],
      estimatedNetCents: 250000,
    });
    const under = leaks.find((l) => l.kind === "underbilled");
    expect(under?.cents).toBe(50000);
    expect(under?.note).toContain("not proof that anything is owed");
    expect(under?.note).not.toMatch(/owed to you|you are owed|guaranteed/i);
  });

  it("reports nothing when nothing is missing", () => {
    // "Nothing is missing" is not a finding, and a detector that always says something is a
    // detector people stop reading.
    const leaks = detectLeaks({
      loadId: "load-1",
      lines: [line({ amountCents: 280000, collectedCents: 280000 })],
      estimatedNetCents: 280000,
      agreedAccessorialsCents: {},
    });
    expect(leaks).toEqual([]);
  });

  it("an unscored load is an absence, not a leak", () => {
    const leaks = detectLeaks({
      loadId: "load-1",
      lines: [line({ amountCents: 280000, collectedCents: 280000 })],
      estimatedNetCents: null,
    });
    expect(leaks.filter((l) => l.kind === "underbilled")).toEqual([]);
  });

  it("every leak is an integer number of cents and a sentence, and nothing else", () => {
    const leaks = detectLeaks({
      loadId: "load-1",
      lines: [line({ amountCents: 280000, collectedCents: 0 })],
      estimatedNetCents: 400000,
      agreedAccessorialsCents: { detention: 15000 },
    });
    expect(leaks.length).toBeGreaterThan(1);
    for (const l of leaks) {
      expect(Number.isInteger(l.cents)).toBe(true);
      expect(l.cents).toBeGreaterThan(0);
      expect(typeof l.note).toBe("string");
      // No action, no recipient, no draft. Rules 10 and 21: a human taps before anything leaves.
      expect(Object.keys(l).sort()).toEqual(["category", "cents", "kind", "loadId", "note"]);
    }
  });

  it("drafts no message and names no recipient anywhere in the module", () => {
    const src = read("packages/domain/week.ts");
    expect(src).not.toMatch(/\bsend\(|sendEmail|sendSms|draftMessage|notify\(/);
  });
});

describe("the money language never promises", () => {
  it("no banned word appears in the code of either new module", () => {
    for (const f of ["packages/domain/week.ts", "supabase/migrations/0006_ledger_and_approved_action.sql"]) {
      const code = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("--"))
        .join("\n")
        .toLowerCase();
      for (const banned of ["take-home", "take home", "guaranteed", "we'll get you paid", "profit"]) {
        expect(code, `${f} contains "${banned}"`).not.toContain(banned);
      }
    }
  });
});
