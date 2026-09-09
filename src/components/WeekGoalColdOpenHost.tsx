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

  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_KEY)) return;
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      return;
    }
    setVisible(true);
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
