import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";

export type TruckColor = { name: string; value: string };

export const TRUCK_COLORS: TruckColor[] = [
  { name: "Chrome", value: "#D6DAE0" },
  { name: "Amber", value: "#FFB020" },
  { name: "Green", value: "#3DDC84" },
  { name: "Red", value: "#FF5A5F" },
  { name: "Sky", value: "#7CC4FF" },
];

let glyphSeed = 0;

/** Small rendered-looking 18-wheeler: body gradient, chrome highlights, ground shadow. */
export function TruckGlyph({ color, className }: { color: string; className?: string }) {
  const [id] = useState(() => `tg${++glyphSeed}`);
  return (
    <svg viewBox="0 0 64 34" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.85" />
          <stop offset="35%" stopColor={color} />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id={`${id}-cab`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.7" />
          <stop offset="45%" stopColor={color} />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.5" />
        </linearGradient>
        <radialGradient id={`${id}-shadow`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#000000" stopOpacity="0.65" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* ground shadow */}
      <ellipse cx="32" cy="31" rx="27" ry="3.2" fill={`url(#${id}-shadow)`} />

      {/* trailer */}
      <rect x="1" y="7" width="35" height="16" rx="2.5" fill={`url(#${id}-body)`} />
      <rect x="2.5" y="8.5" width="32" height="3" rx="1.5" fill="#FFFFFF" opacity="0.35" />
      <rect x="1" y="19" width="35" height="4" rx="1.5" fill="#000000" opacity="0.25" />

      {/* cab */}
      <path d="M38 10h9.5l8 8v5H38z" fill={`url(#${id}-cab)`} />
      <path d="M38 10h9.5l2 4H38z" fill="#FFFFFF" opacity="0.3" />
      <rect x="47.5" y="13" width="6" height="4.5" rx="1" fill="#0B0C0E" opacity="0.85" />
      <rect x="47.8" y="13.3" width="5.4" height="1.6" rx="0.8" fill="#FFFFFF" opacity="0.3" />

      {/* chrome trim */}
      <rect x="36.4" y="9" width="1.6" height="14" rx="0.8" fill="#EDEEF0" opacity="0.7" />
      <rect x="38" y="21.5" width="18" height="2" rx="1" fill="#EDEEF0" opacity="0.55" />

      {/* wheels */}
      {[10, 19, 28, 43, 53].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="25" r="4" fill="#15181C" />
          <circle cx={cx} cy="25" r="1.7" fill="#C9CED6" />
          <circle cx={cx} cy="23.6" r="3.6" fill="#FFFFFF" opacity="0.08" />
        </g>
      ))}
    </svg>
  );
}

export function GoalBar({
  progress,
  truckColor,
  big,
}: {
  progress: number; // 0..1
  truckColor: string;
  big?: boolean;
}) {
  const pct = Math.max(0, Math.min(1, progress));
  return (
    <div className="relative">
      {/* track */}
      <div
        className={`relative w-full overflow-hidden rounded-full bg-surface-2 ring-1 ring-white/5 ${
          big ? "h-4" : "h-2.5"
        }`}
      >
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{
            width: `${pct * 100}%`,
            background: "linear-gradient(90deg, #7A4A05 0%, #C98515 45%, #FFB020 85%, #FFD37A 100%)",
            boxShadow: "0 0 18px rgba(255,176,32,0.45)",
          }}
        />
      </div>
      {/* truck riding the leading edge of the fill */}
      <div
        className="absolute -top-1 transition-all duration-700 ease-out"
        style={{ left: `calc(${pct * 100}% - ${pct * (big ? 56 : 32)}px)` }}
      >
        <TruckGlyph
          color={truckColor}
          className={big ? "h-10 w-20 -translate-y-7" : "h-5 w-9 -translate-y-3.5"}
        />
      </div>
    </div>
  );
}

export function useTruckColor() {
  const [color, setColor] = useState(TRUCK_COLORS[0]!.value);
  return [color, setColor] as const;
}

export function GoalGlanceCard({
  progress,
  truckColor,
  earned,
  target,
}: {
  progress: number;
  truckColor: string;
  earned: string;
  target: string;
}) {
  return (
    <Link
      to="/goal"
      className="block rounded-xl border border-border bg-card p-4 active:opacity-80"
    >
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold">This week's goal</span>
        <span className="text-muted-foreground">
          {earned} of {target}
        </span>
      </div>
      <div className="mt-5">
        <GoalBar progress={progress} truckColor={truckColor} />
      </div>
    </Link>
  );
}

export function ColorPickerButton({
  color,
  onPick,
}: {
  color: string;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Truck color"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-border bg-card"
      >
        <Settings2 className="size-5" style={{ color }} />
      </button>
      {open ? (
        <div className="absolute right-0 top-12 z-30 rounded-xl border border-border bg-card p-3 shadow-lg">
          <p className="mb-2 text-xs font-semibold text-muted-foreground">Truck color</p>
          <div className="flex gap-2">
            {TRUCK_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                aria-label={c.name}
                onClick={() => {
                  onPick(c.value);
                  setOpen(false);
                }}
                className={`size-9 min-h-11 min-w-11 rounded-full border-2 ${
                  color === c.value ? "border-foreground" : "border-border"
                }`}
                style={{ backgroundColor: c.value }}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
