import { useEffect, useState } from "react";
import { TruckGlyph, useTruckColor, WeeklyGoalChart } from "@/components/GoalProgress";
import { WEEK_DAY_EARNINGS, WEEK_GOAL, money } from "@/lib/goal";

const SESSION_KEY = "ez-intro-played";
const CHART_EARNED = WEEK_DAY_EARNINGS.reduce((sum, day) => sum + (day.amount ?? 0), 0);

/**
 * One-time cold-open intro: chrome truck drives in, turns, then rides the goal
 * bar to the real week progress. Visual only — same math as the Week $ page.
 */
export function IntroAnimation() {
  const [phase, setPhase] = useState<"off" | "drive" | "chart" | "out">("off");
  const [chartReveal, setChartReveal] = useState(0);
  const [truckColor] = useTruckColor();

  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_KEY)) return;
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setPhase("drive");
    const t1 = setTimeout(() => {
      setPhase("chart");
      requestAnimationFrame(() => setChartReveal(1));
    }, 1200);
    const t2 = setTimeout(() => setPhase("out"), 2250);
    const t3 = setTimeout(() => setPhase("off"), 2550);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  if (phase === "off") return null;

  return (
    <div
      aria-hidden="true"
      className={`fixed inset-0 z-50 flex items-center justify-center bg-background px-6 transition-opacity duration-300 ${
        phase === "out" ? "opacity-0" : "opacity-100"
      }`}
    >
      <div className="w-full max-w-md">
        {phase === "drive" ? (
          <div className="flex h-64 items-center justify-center overflow-hidden">
            <TruckGlyph color={truckColor} className="ez-intro-approach h-28 w-52" />
          </div>
        ) : (
          <div className="pt-8">
            <div className="mb-2 flex items-baseline justify-between text-sm">
              <span className="font-semibold">This week's goal</span>
              <span className="ez-num">
                {money(CHART_EARNED)}{" "}
                <span className="text-muted-foreground">of {money(WEEK_GOAL.target)}</span>
              </span>
            </div>
            <WeeklyGoalChart
              days={[...WEEK_DAY_EARNINGS]}
              target={WEEK_GOAL.target}
              truckColor={truckColor}
              reveal={chartReveal}
              compact
            />
          </div>
        )}
      </div>
    </div>
  );
}
