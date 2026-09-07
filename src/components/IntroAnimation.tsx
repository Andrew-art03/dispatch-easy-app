import { useEffect, useState } from "react";
import { useTruckBody, useTruckColor, truckBodyImage } from "@/components/GoalProgress";
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
  const [truckBody] = useTruckBody();
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
      <p className="font-condensed text-2xl font-bold uppercase tracking-[0.28em] text-foreground">
        EZ Trucking
      </p>

      <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Weekly payout goal
      </p>
      <p className="ez-num mt-1 text-5xl text-foreground">
        {earnedLabel} <span className="text-muted-foreground">of {targetLabel}</span>
      </p>

      {/* Ramp + truck */}
      <div className="relative mt-8 h-44 w-full max-w-sm">
        <div className="absolute inset-x-0 bottom-0 flex h-40 items-end justify-between gap-2">
          {bars.map((h, i) => (
            <div
              key={h}
              className="ez-splash-bar flex-1 rounded-t-md"
              style={{
                height: `${h * 100}%`,
                background: "linear-gradient(180deg, #FFB020 0%, #7A4A05 100%)",
                opacity: 0.85,
                animationDelay: settled ? "0ms" : `${i * 90}ms`,
              }}
            />
          ))}
        </div>

        {/* goal marker, top right */}
        <span className="absolute right-0 top-0 rounded-full border border-ez-amber px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ez-amber">
          Goal
        </span>

        <img
          src={truckBodyImage(truckBody)}
          alt=""
          aria-hidden="true"
          draggable={false}
          className={`pointer-events-none absolute bottom-6 left-0 h-16 w-28 select-none object-contain ${
            settled ? "ez-splash-parked" : "ez-splash-climb"
          }`}
          style={{
            filter: `drop-shadow(0 8px 12px rgba(0,0,0,0.6)) drop-shadow(0 14px 22px ${truckColor})`,
          }}
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
