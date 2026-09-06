import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Receipt } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { GoalConfetti } from "@/components/GoalConfetti";
import {
  ColorPickerButton,
  WeeklyGoalChart,
  useTruckColor,
  type WeekDayEarning,
} from "@/components/GoalProgress";
import { WEEK_DAY_EARNINGS, WEEK_GOAL, money } from "@/lib/goal";

export const Route = createFileRoute("/_authenticated/goal")({
  head: () => ({
    meta: [
      { title: "Week goal — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content:
          "Your weekly pay target, this week's true net so far, and the loads that get you there.",
      },
      { property: "og:title", content: "Week goal — EZ Trucking Auto Dispatching" },
      { property: "og:description", content: "Track this week's true net against your pay goal." },
    ],
  }),
  component: GoalPage,
});

// Visual-only mock data — no tables touched.
const MOCK = {
  routes: [
    { from: "Amarillo, TX", to: "Dallas, TX", date: "Tue Sep 8", net: 1450 },
    { from: "Dallas, TX", to: "Atlanta, GA", date: "Thu Sep 10", net: 1890 },
    { from: "Atlanta, GA", to: "Charlotte, NC", date: "Sat Sep 12", net: 720 },
  ],
};

function GoalPage() {
  const [truckColor, setTruckColor] = useTruckColor();
  const [target, setTarget] = useState(WEEK_GOAL.target);
  const [days, setDays] = useState<WeekDayEarning[]>([...WEEK_DAY_EARNINGS]);
  const [showCelebration, setShowCelebration] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [showRaisePrompt, setShowRaisePrompt] = useState(false);
  const previousEarned = useRef(WEEK_GOAL.earned);
  const celebrationKey = `ez-goal-celebrated:${WEEK_GOAL.weekLabel}`;
  const earned = useMemo(() => days.reduce((sum, day) => sum + (day.amount ?? 0), 0), [days]);

  useEffect(() => {
    const crossed = previousEarned.current < target && earned >= target;
    previousEarned.current = earned;
    if (!crossed) return;
    try {
      if (localStorage.getItem(celebrationKey)) return;
      localStorage.setItem(celebrationKey, "1");
    } catch {
      // The demo still celebrates when storage is unavailable.
    }
    setShowCelebration(true);
    setShowConfetti(true);
    setShowRaisePrompt(true);
  }, [celebrationKey, earned, target]);

  const simulateDelivery = () => {
    setDays((current) =>
      current.map((day) => (day.day === "Sat" ? { ...day, amount: (day.amount ?? 0) + 800 } : day)),
    );
  };

  const dismissConfetti = useCallback(() => setShowConfetti(false), []);

  const chooseTarget = (nextTarget: number) => {
    setTarget(nextTarget);
    setShowRaisePrompt(false);
  };

  return (
    <AppShell
      title="Week $"
      action={<ColorPickerButton color={truckColor} onPick={setTruckColor} />}
    >
      <section className="rounded-2xl border border-border bg-card p-5 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">This week's goal</h2>
            <div className="mt-2 h-0.5 w-14 rounded-full bg-ez-amber" />
          </div>
          <p className="ez-num shrink-0 text-2xl">
            {money(earned)}{" "}
            <span className="text-muted-foreground">of {money(WEEK_GOAL.target)}</span>
          </p>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">{WEEK_GOAL.weekLabel}</p>

        <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {days.map((day, index) => {
            const runningTotal = days
              .slice(0, index + 1)
              .reduce((sum, d) => sum + (d.amount ?? 0), 0);
            const logged = day.amount !== null;
            return (
              <li
                key={day.day}
                className={logged ? "text-foreground" : "text-muted-foreground/50"}
              >
                <span className="font-semibold">{day.day}</span>{" "}
                <span className="ez-num">{logged ? money(runningTotal) : "—"}</span>
              </li>
            );
          })}
        </ul>
        <p className="mt-1 text-xs text-muted-foreground">Running total, day by day.</p>

        <div className="relative mt-2">
          {showConfetti ? <GoalConfetti onDone={dismissConfetti} /> : null}
          <WeeklyGoalChart days={days} target={target} truckColor={truckColor} />
        </div>

        <p className="mt-2 text-sm text-muted-foreground">
          {earned >= target
            ? `${money(earned - target)} over goal.`
            : `${money(target - earned)} to go.`}
        </p>

        <button
          type="button"
          onClick={simulateDelivery}
          disabled={days.some((day) => day.day === "Sat" && day.amount !== null)}
          className="ez-btn-secondary mt-4 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Simulate delivery +$800
        </button>
      </section>

      {showCelebration ? (
        <section className="mt-5 rounded-2xl border border-ez-green/40 bg-card p-5">
          <p className="ez-num text-4xl">You did it.</p>
          <p className="mt-2 text-lg text-muted-foreground">Congratulations — that's the week.</p>
        </section>
      ) : null}

      {showRaisePrompt ? (
        <section className="mt-4 rounded-2xl border border-ez-amber/40 bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full border-2 border-ez-amber font-bold text-ez-amber">
              E
            </span>
            <div>
              <p className="font-semibold">
                Want to raise next week's goal? I'd go +$1,000 — {money(target + 1000)}.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Suggested from your ledger — your call.
              </p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => chooseTarget(target + 1000)}
              className="ez-btn-amber min-h-12"
            >
              Raise to {money(target + 1000)}
            </button>
            <button type="button" onClick={() => chooseTarget(target)} className="ez-btn-secondary">
              Keep {money(target)}
            </button>
          </div>
        </section>
      ) : null}

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          This week's runs · {MOCK.routes.length}
        </h2>
        <ul className="space-y-2">
          {MOCK.routes.map((r) => (
            <li
              key={`${r.from}-${r.to}`}
              className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border bg-card p-4"
            >
              <div className="min-w-0">
                <p className="truncate font-semibold">
                  {r.from} → {r.to}
                </p>
                <p className="text-sm text-muted-foreground">{r.date}</p>
              </div>
              <p className="ez-num shrink-0 text-xl">{money(r.net)}</p>
            </li>
          ))}
        </ul>
      </section>

      <Link
        to="/ledger"
        className="mt-4 flex min-h-14 items-center justify-between rounded-xl border border-border bg-card p-4 active:opacity-80"
      >
        <span className="flex items-center gap-3 font-semibold">
          <Receipt className="size-5 text-muted-foreground" />
          Money in and out
        </span>
        <span className="text-sm text-muted-foreground">Open →</span>
      </Link>
    </AppShell>
  );
}
