import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";

export type TruckColor = { name: string; value: string };

export const TRUCK_COLORS: TruckColor[] = [
  { name: "Green", value: "#3DDC84" },
  { name: "Amber", value: "#FFB020" },
  { name: "Red", value: "#FF5A5F" },
  { name: "Sky", value: "#7CC4FF" },
  { name: "White", value: "#EDEEF0" },
];

/** 18-wheeler SVG, tinted by `color`. */
export function TruckGlyph({ color, className }: { color: string; className?: string }) {
  return (
    <svg viewBox="0 0 64 32" className={className} aria-hidden="true">
      <rect x="0" y="6" width="36" height="18" rx="2" fill={color} opacity="0.55" />
      <path d="M38 10h10l8 8v6H38z" fill={color} />
      <rect x="47" y="13" width="6" height="5" rx="1" fill="var(--color-background)" />
      <circle cx="10" cy="26" r="4" fill={color} />
      <circle cx="20" cy="26" r="4" fill={color} />
      <circle cx="30" cy="26" r="4" fill={color} />
      <circle cx="44" cy="26" r="4" fill={color} />
      <circle cx="56" cy="26" r="4" fill={color} />
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
      <div className={`relative w-full overflow-hidden rounded-full bg-secondary ${big ? "h-5" : "h-2.5"}`}>
        <div
          className="h-full rounded-full bg-primary transition-all duration-700 ease-out"
          style={{ width: `${pct * 100}%` }}
        />
      </div>
      {/* truck riding the bar */}
      <div
        className="absolute -top-1 transition-all duration-700 ease-out"
        style={{ left: `calc(${pct * 100}% - ${pct * (big ? 44 : 30)}px)` }}
      >
        <TruckGlyph color={truckColor} className={big ? "h-8 w-16 -translate-y-6" : "h-4 w-8 -translate-y-3"} />
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
