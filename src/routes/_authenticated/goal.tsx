import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Receipt } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { ColorPickerButton, GoalBar, TruckGlyph, useTruckColor } from "@/components/GoalProgress";
import { WEEK_GOAL, money } from "@/lib/goal";

export const Route = createFileRoute("/_authenticated/goal")({
  head: () => ({
    meta: [
      { title: "Week goal — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content: "Your weekly pay target, this week's true net so far, and the loads that get you there.",
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

// Toggle to preview the reached-goal state (design pass only).
const SHOW_GOAL_REACHED = false;

function GoalPage() {
  const [truckColor, setTruckColor] = useTruckColor();
  const earned = SHOW_GOAL_REACHED ? WEEK_GOAL.target : WEEK_GOAL.earned;
  const progress = Math.min(1, earned / WEEK_GOAL.target);
  const reached = progress >= 1;
  const [bumpAnswered, setBumpAnswered] = useState(false);

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

        <div className="mt-12">
          <GoalBar progress={progress} truckColor={truckColor} big />
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted-foreground">
          <span>$0</span>
          <span className="font-semibold text-ez-amber">{money(WEEK_GOAL.target)}</span>
        </div>

        {reached ? (
          <div className="mt-6 rounded-xl border border-primary/40 bg-primary/10 p-4">
            <div className="flex items-center gap-3">
              <TruckGlyph color={truckColor} className="h-9 w-16" />
              <div>
                <p className="font-semibold text-primary">You hit the goal 🎉</p>
                <p className="text-sm text-muted-foreground">Every mile after this is gravy.</p>
              </div>
            </div>
            {!bumpAnswered ? (
              <div className="mt-4 rounded-lg border border-ez-amber/40 bg-ez-amber/10 p-3">
                <p className="text-sm">
                  <span className="font-semibold text-ez-amber">EZ asks:</span> Bump next week's
                  goal to $6,500?
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setBumpAnswered(true)}
                    className="ez-btn-secondary min-h-12"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setBumpAnswered(true)}
                    className="ez-btn-secondary min-h-12"
                  >
                    Not now
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">
            {money(WEEK_GOAL.target - earned)} to go — the loads below get you there.
          </p>
        )}
      </section>

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
