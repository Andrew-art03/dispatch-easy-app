import { useEffect, useState } from "react";
import { TruckGlyph, useTruckColor } from "@/components/GoalProgress";

const SESSION_KEY = "ez-intro-played";

/**
 * Cold-open splash: the chrome truck drives toward the viewer out of the dark,
 * then the overlay fades straight into the landing screen. Plays once per
 * session, caps under 2s, skipped entirely with reduced motion.
 */
export function IntroAnimation() {
  const [phase, setPhase] = useState<"off" | "drive" | "out">("off");
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
    const t1 = setTimeout(() => setPhase("out"), 1400);
    const t2 = setTimeout(() => setPhase("off"), 1700);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  if (phase === "off") return null;

  return (
    <div
      aria-hidden="true"
      className={`fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-background transition-opacity duration-300 ${
        phase === "out" ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* headlight glow blooms behind the truck as it closes in */}
      <div className="ez-splash-glow absolute h-72 w-72 rounded-full" />
      <TruckGlyph color={truckColor} className="ez-splash-drive h-40 w-72" />
    </div>
  );
}
