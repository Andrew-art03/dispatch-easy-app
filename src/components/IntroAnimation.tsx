import { useEffect, useState } from "react";
import { useTruckColor } from "@/components/GoalProgress";
import { TruckImage } from "@/components/TruckImage";
import { WEEK_GOAL, money } from "@/lib/goal";
import { supabase } from "@/lib/supabase";

const SESSION_KEY = "ez-intro-played";

/**
 * Cold-open splash. Presentation layer only — no data is written and no
 * navigation happens on its own. The driver's picked truck drives in from the
 * left and climbs an amber ramp toward the weekly goal marker, the splash then
 * holds with a progress indicator, and finally offers a Continue button.
 * Plays once per session; reduced motion shows the final frame immediately.
 */
export function IntroAnimation() {
  const [phase, setPhase] = useState<"off" | "drive" | "loading" | "ready" | "out">("off");
  const [truckColor] = useTruckColor();
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_KEY)) return;
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPhase("ready");
      return;
    }
    setPhase("drive");
    const t1 = setTimeout(() => setPhase("loading"), 1500);
    const t2 = setTimeout(() => setPhase("ready"), 3800);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  useEffect(() => {
    if (phase === "off") return;
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) setSignedIn(Boolean(data.session));
    });
    return () => {
      alive = false;
    };
  }, [phase]);

  if (phase === "off") return null;

  const settled = phase !== "drive";
  const earnedLabel = signedIn ? money(WEEK_GOAL.earned) : "$0";
  const targetLabel = signedIn ? money(WEEK_GOAL.target) : "$—";

  // Rising ramp: five bars stepping up toward the goal marker, top right.
  const bars = [0.22, 0.4, 0.56, 0.74, 0.92];

  return (
    <div
      role="dialog"
      aria-label="Welcome to EZ Trucking"
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-background px-6 transition-opacity duration-300 ${
        phase === "out" ? "opacity-0" : "opacity-100"
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-accent text-xl font-black text-accent-foreground">
          EZ
        </span>
        <span className="font-condensed text-2xl font-bold uppercase tracking-[0.24em] text-foreground">
          EZ Trucking
        </span>
      </div>

      <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Weekly payout goal
      </p>
      <p className="ez-num mt-1 text-4xl text-foreground">
        {earnedLabel} <span className="text-muted-foreground">of {targetLabel}</span>
      </p>

      {/* Ramp + truck — same card language as the rest of the app */}
      <div className="relative mt-8 h-48 w-full max-w-sm rounded-2xl border border-border bg-card p-4">
        <div className="absolute inset-x-4 bottom-4 flex h-36 items-end justify-between gap-2">
          {bars.map((h, i) => (
            <div
              key={h}
              className="ez-splash-bar flex-1 rounded-t-md"
              style={{
                height: `${h * 100}%`,
                background:
                  "linear-gradient(180deg, var(--color-accent) 0%, color-mix(in oklab, var(--color-accent) 25%, var(--color-card)) 100%)",
                opacity: 0.9,
                animationDelay: settled ? "0ms" : `${i * 90}ms`,
              }}
            />
          ))}
        </div>

        {/* goal marker, top right */}
        <span className="absolute right-4 top-4 rounded-full border border-ez-amber px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ez-amber">
          Goal
        </span>

        <TruckImage
          glowColor={truckColor}
          className={`pointer-events-none absolute bottom-10 left-4 h-16 w-28 select-none object-contain ${
            settled ? "ez-splash-parked" : "ez-splash-climb"
          }`}
        />
      </div>

      <div className="mt-8 flex h-24 w-full max-w-xs flex-col items-center justify-start">
        {phase === "loading" ? (
          <>
            <span
              className="size-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
              aria-label="Loading"
            />
            <div className="mt-4 h-1 w-40 overflow-hidden rounded-full bg-secondary">
              <div className="ez-splash-progress h-full rounded-full bg-accent" />
            </div>
          </>
        ) : null}
        {phase === "ready" || phase === "out" ? (
          <button
            type="button"
            autoFocus
            onClick={() => {
              setPhase("out");
              setTimeout(() => setPhase("off"), 350);
            }}
            className="ez-btn-amber animate-fade-in"
          >
            Continue
          </button>
        ) : null}
      </div>
    </div>
  );
}
