import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import goalTruckAsset from "@/assets/goal-truck.png.asset.json";

export type TruckColor = { name: string; value: string };

export const TRUCK_COLORS: TruckColor[] = [
  { name: "Chrome", value: "#D6DAE0" },
  { name: "Amber", value: "#FFB020" },
  { name: "Green", value: "#3DDC84" },
  { name: "Red", value: "#FF5A5F" },
  { name: "Sky", value: "#7CC4FF" },
];

/**
 * Chrome truck photo riding the goal bar. The body always stays chrome;
 * the picked color only tints the glow beneath it via a colored drop-shadow.
 */
export function TruckGlyph({ color, className }: { color: string; className?: string }) {
  return (
    <img
      src={goalTruckAsset.url}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`select-none object-contain ${className ?? ""}`}
      style={{
        filter: `drop-shadow(0 6px 10px rgba(0,0,0,0.55)) drop-shadow(0 14px 22px ${color})`,
      }}
    />
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
        style={{ left: `calc(${pct * 100}% - ${pct * (big ? 84 : 40)}px)` }}
      >
        <TruckGlyph
          color={truckColor}
          className={big ? "h-16 w-28 -translate-y-11" : "h-7 w-12 -translate-y-4"}
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
      <div className="mt-8">
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
