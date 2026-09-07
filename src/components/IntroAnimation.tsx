import { useEffect, useState } from "react";
import { TruckGlyph, useTruckColor } from "@/components/GoalProgress";

const SESSION_KEY = "ez-intro-played";

/**
 * Cold-open splash: the chrome truck drives toward the viewer out of the dark,
 * then the splash holds with a loading indicator, then offers a Continue
 * button. The app never auto-advances — the driver taps Continue to land on
 * Login/Board. Plays once per session; reduced motion skips it entirely.
 */
export function IntroAnimation() {
  const [phase, setPhase] = useState<"off" | "drive" | "loading" | "ready" | "out">("off");
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
    const t1 = setTimeout(() => setPhase("loading"), 1400);
    const t2 = setTimeout(() => setPhase("ready"), 3800);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  if (phase === "off") return null;

  const settled = phase === "loading" || phase === "ready" || phase === "out";

  return (
    <div
      role="dialog"
      aria-label="Welcome to EZ Trucking"
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-background transition-opacity duration-300 ${
        phase === "out" ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* headlight glow blooms behind the truck as it closes in */}
      <div
        aria-hidden="true"
        className={`ez-splash-glow absolute h-72 w-72 rounded-full ${settled ? "ez-splash-settled" : ""}`}
      />
      <TruckGlyph
        color={truckColor}
        className={`h-40 w-72 ${settled ? "ez-splash-settled" : "ez-splash-drive"}`}
      />

      <p className="mt-10 font-condensed text-xl font-bold uppercase tracking-[0.2em] text-foreground">
        EZ Trucking
      </p>

      <div className="mt-6 flex h-24 flex-col items-center justify-start">
        {phase === "loading" ? (
          <>
            <span
              className="size-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
              aria-label="Loading"
            />
            <div className="mt-4 h-1 w-40 overflow-hidden rounded-full bg-secondary">
              <div className="ez-splash-progress h-full rounded-full bg-primary" />
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
