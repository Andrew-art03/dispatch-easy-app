import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";

/**
 * Easy's visual presence — animation only.
 * No speech-to-text, no text-to-speech, no network. The ring pulses once when
 * the driver moves to a new screen, then settles into a slow idle breath.
 */
export function EZPresence() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [awake, setAwake] = useState(true);

  useEffect(() => {
    setAwake(true);
    const timer = setTimeout(() => setAwake(false), 1400);
    return () => clearTimeout(timer);
  }, [pathname]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed bottom-24 right-4 z-30 flex size-11 items-center justify-center"
    >
      <span
        className={`absolute inset-0 rounded-full border border-ez-amber/40 ${
          awake ? "animate-ping" : "animate-pulse"
        }`}
      />
      <span
        className={`absolute rounded-full border-2 border-ez-amber transition-all duration-500 ${
          awake ? "inset-0 opacity-100" : "inset-1 opacity-70"
        }`}
      />
      <span className="text-sm font-bold text-ez-amber">E</span>
    </div>
  );
}
