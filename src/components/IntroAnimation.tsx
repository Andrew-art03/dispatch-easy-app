import { useEffect, useState } from "react";
import { GoalBar, TruckGlyph, useTruckColor } from "@/components/GoalProgress";
import { WEEK_GOAL, money } from "@/lib/goal";

const SESSION_KEY = "ez-intro-played";

/**
 * One-time cold-open intro: chrome truck drives in, turns, then rides the goal
 * bar to the real week progress. Visual only — same math as the Week $ page.
 */
export function IntroAnimation() {
  const [phase, setPhase] = useState<"off" | "drive" | "bar" | "out">("off");
  const [barProgress, setBarProgress] = useState(0);

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
      setPhase("bar");
      requestAnimationFrame(() =>
        setBarProgress(Math.min(1, WEEK_GOAL.earned / WEEK_GOAL.target)),
      );
    }, 700);
    const t2 = setTimeout(() => setPhase("out"), 1700);
    const t3 = setTimeout(() => setPhase("off"), 2050);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  if (phase === "off") return null;

  const [truckColor] = useTruckColor();

  return (
    <div
      aria-hidden="true"
      className={`fixed inset-0 z-50 flex items-center justify-center bg-background px-6 transition-opacity duration-300 ${
        phase === "out" ? "opacity-0" : "opacity-100"
      }`}
    >
      <div className="w-full max-w-md">
        {phase === "drive" ? (
          <div className="flex h-40 items-center justify-center">
            <TruckGlyph color={truckColor} className="ez-intro-drive h-24 w-44" />
          </div>
        ) : (
          <div className="h-40 pt-16">
            <div className="mb-8 flex items-baseline justify-between text-sm">
              <span className="font-semibold">This week's goal</span>
              <span className="ez-num">
                {money(WEEK_GOAL.earned)}{" "}
                <span className="text-muted-foreground">of {money(WEEK_GOAL.target)}</span>
              </span>
            </div>
            <GoalBar progress={barProgress} truckColor={truckColor} big />
          </div>
        )}
      </div>
    </div>
  );
}
