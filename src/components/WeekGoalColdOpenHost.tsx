import { useEffect, useState } from "react";
import { WeekGoalColdOpen, type ColdOpenDay } from "@/components/WeekGoalColdOpen";
import { WEEK_DAY_EARNINGS, WEEK_GOAL } from "@/lib/goal";
import { supabase } from "@/lib/supabase";

const SESSION_KEY = "ez-coldopen-played";
const LABELS = ["MON", "TUE", "WED", "THU", "FRI"];

/** Sample week, used only until the driver's own ledger has money in it. */
const FIXTURE: ColdOpenDay[] = LABELS.map((label, i) => ({
  label,
  amountCents: Math.round((WEEK_DAY_EARNINGS[i]?.amount ?? 0) * 100),
}));

function mondayOfThisWeek() {
  const now = new Date();
  const day = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  return monday;
}

/**
 * Cold open host: plays the Week Goal film once per cold open, then hands the
 * driver to the app. Money comes from the ledger this app already uses; when
 * there is nothing there yet it renders the sample week with a SAMPLE tag.
 */
export function WeekGoalColdOpenHost() {
  const [visible, setVisible] = useState(false);
  const [days, setDays] = useState<ColdOpenDay[]>(FIXTURE);
  const [isFixture, setIsFixture] = useState(true);

  /**
   * SIGNED-IN ONLY. This host is mounted in `__root.tsx`, so it renders on every route —
   * including `/auth`, where it used to drop a `fixed inset-0 z-50` panel over the sign-in
   * form. A driver opening the app cold got a week-goal film, showing SAMPLE money, on top
   * of the form, and could not tap anything underneath it until they found "Continue".
   *
   * Found by tests/e2e/auth.spec.ts, which could not click the mode tabs:
   *   "<svg …WeekGoalColdOpen…> from <div …WeekGoalColdOpenHost…> subtree intercepts
   *    pointer events"
   *
   * Two things wrong with it and both are fixed by the same gate: a signed-out visitor
   * could not use the screen (A-03 — ease of use is a release criterion), and they were
   * shown a week of earnings before the product knew who they were.
   *
   * The session check comes BEFORE the once-per-cold-open flag on purpose. Burning the
   * flag on the auth screen would mean the driver never saw the film on the home screen
   * they actually signed in to — trading one defect for a quieter one.
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!alive || !data.session) return;
      try {
        if (sessionStorage.getItem(SESSION_KEY)) return;
        sessionStorage.setItem(SESSION_KEY, "1");
      } catch {
        return;
      }
      if (alive) setVisible(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const monday = mondayOfThisWeek();
    (async () => {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) return;
      const { data, error } = await supabase
        .from("ledger_line")
        .select("amount, at")
        .gte("at", monday.toISOString());
      if (!alive || error || !data || data.length === 0) return;
      const totals = [0, 0, 0, 0, 0];
      let any = false;
      for (const row of data as { amount: number | string; at: string | null }[]) {
        const cents = Math.round(Number(row.amount) * 100);
        if (!row.at || cents <= 0) continue;
        const index = (new Date(row.at).getDay() + 6) % 7;
        if (index > 4) continue;
        totals[index] = (totals[index] ?? 0) + cents;
        any = true;
      }
      if (!any) return;
      setDays(LABELS.map((label, i) => ({ label, amountCents: totals[i] ?? 0 })));
      setIsFixture(false);
    })();
    return () => {
      alive = false;
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background px-3.5 py-5">
      <WeekGoalColdOpen
        goalCents={Math.round(WEEK_GOAL.target * 100)}
        days={days}
        isFixture={isFixture}
        onContinue={() => setVisible(false)}
      />
    </div>
  );
}
