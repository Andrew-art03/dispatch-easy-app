import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import goalTruckAsset from "@/assets/goal-truck.png.asset.json";
import lowboyAsset from "@/assets/truck-lowboy.jpg.asset.json";
import gooseneckAsset from "@/assets/truck-gooseneck.jpg.asset.json";
import copilotAvatarAsset from "@/assets/ez-copilot-avatar.png.asset.json";
import bobtailAsset from "@/assets/truck-bobtail.png.asset.json";
import vanAsset from "@/assets/truck-van.png.asset.json";
import flatbedSemiAsset from "@/assets/truck-flatbed-semi.png.asset.json";
import flatbedAsset from "@/assets/truck-flatbed.png.asset.json";

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
  const [body] = useTruckBody();
  return (
    <img
      src={truckBodyImage(body)}
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
            background:
              "linear-gradient(90deg, #7A4A05 0%, #C98515 45%, #FFB020 85%, #FFD37A 100%)",
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

export type WeekDayEarning = {
  day: string;
  amount: number | null;
};

export function WeeklyGoalChart({
  days,
  target,
  truckColor,
  reveal = 99,
  compact = false,
}: {
  days: WeekDayEarning[];
  target: number;
  truckColor: string;
  /** Absolute animated day-index (1 = first active marker, 2 = second, …). */
  reveal?: number;
  compact?: boolean;
}) {
  const width = 700;
  const height = compact ? 230 : 310;
  const left = 48;
  const right = 660;
  const top = compact ? 34 : 52;
  const bottom = compact ? 178 : 238;
  const activeDays = days.filter((day) => day.amount !== null);
  const totals: number[] = [];
  let running = 0;
  for (const day of days) {
    if (day.amount !== null) running += day.amount;
    totals.push(running);
  }
  const ceiling = Math.max(target, running, 1);
  const points = days.map((_, index) => ({
    x: left + ((right - left) * index) / Math.max(days.length - 1, 1),
    y: bottom - (Math.min(totals[index] ?? 0, ceiling) / ceiling) * (bottom - top),
  }));
  const activeCount = activeDays.length;
  const activePoints = points.slice(0, activeCount);
  // `reveal` is an absolute day-index, so it never rescales when activeCount
  // changes — a newly posted day animates exactly one marker forward.
  const scaledIndex = Math.max(0, Math.min(reveal, Math.max(activeCount - 1, 0)));
  const startIndex = Math.floor(scaledIndex);
  const endIndex = Math.min(startIndex + 1, Math.max(activeCount - 1, 0));
  const fraction = scaledIndex - startIndex;
  const startPoint = activePoints[startIndex] ?? { x: left, y: bottom };
  const endPoint = activePoints[endIndex] ?? startPoint;
  const truckPoint = {
    x: startPoint.x + (endPoint.x - startPoint.x) * fraction,
    y: startPoint.y + (endPoint.y - startPoint.y) * fraction,
  };
  const linePoints = activePoints.map((point) => `${point.x},${point.y}`).join(" ");
  const fillPoints = `${left},${bottom} ${linePoints} ${activePoints.at(-1)?.x ?? left},${bottom}`;
  const futurePoints = points
    .slice(Math.max(activeCount - 1, 0))
    .map((point) => `${point.x},${point.y}`)
    .join(" ");

  return (
    <div className={`relative w-full ${compact ? "h-44" : "h-64"}`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-full w-full overflow-visible"
        role="img"
        aria-label={`Weekly earnings: ${activeDays.map((day) => `${day.day} ${moneyLabel(day.amount ?? 0)}`).join(", ")}`}
      >
        <defs>
          <linearGradient
            id={`week-fill-${compact ? "compact" : "full"}`}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stopColor="var(--color-ez-amber)" stopOpacity="0.42" />
            <stop offset="100%" stopColor="var(--color-ez-amber)" stopOpacity="0.03" />
          </linearGradient>
          <filter
            id={`week-glow-${compact ? "compact" : "full"}`}
            x="-30%"
            y="-30%"
            width="160%"
            height="160%"
          >
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <clipPath id={`week-reveal-${compact ? "compact" : "full"}`}>
            <rect x="0" y="0" width={truckPoint.x + 2} height={height} />
          </clipPath>

        </defs>

        <line
          x1={left}
          y1={top}
          x2={right}
          y2={top}
          stroke="var(--color-ez-amber)"
          strokeOpacity="0.5"
          strokeDasharray="7 7"
        />
        {!compact ? (
          <text
            x={right}
            y={top - 14}
            textAnchor="end"
            fill="var(--color-ez-amber)"
            fontSize="24"
            fontWeight="700"
          >
            Goal {moneyLabel(target)}
          </text>
        ) : null}

        <polyline
          points={futurePoints}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <g clipPath={`url(#week-reveal-${compact ? "compact" : "full"})`}>
          <polygon points={fillPoints} fill={`url(#week-fill-${compact ? "compact" : "full"})`} />
          <polyline
            points={linePoints}
            fill="none"
            stroke="var(--color-ez-amber)"
            strokeWidth="9"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter={`url(#week-glow-${compact ? "compact" : "full"})`}
          />
        </g>

        {days.map((day, index) => {
          const point = points[index];
          if (!point) return null;
          const active = day.amount !== null;
          const reached = point.x <= truckPoint.x + 2;
          return (
            <g key={day.day} opacity={active ? 1 : 0.35}>
              <g
                style={{
                  opacity: !active || reached ? 1 : 0,
                  transform: !active || reached ? "scale(1)" : "scale(0.4)",
                  transformBox: "fill-box",
                  transformOrigin: "center",
                  transition: "opacity 260ms ease-out, transform 260ms ease-out",
                }}
              >
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={active ? 8 : 6}
                  fill={active ? "var(--color-ez-amber)" : "var(--color-surface-2)"}
                  stroke="var(--color-background)"
                  strokeWidth="4"
                />
              </g>
              {!compact && active ? (
                <text
                  x={point.x}
                  y={point.y - 22}
                  textAnchor="middle"
                  fill="var(--color-foreground)"
                  fontSize="21"
                  fontWeight="700"
                  style={{
                    opacity: reached ? 1 : 0,
                    transition: "opacity 300ms ease-out",
                  }}
                >
                  {moneyLabel(day.amount ?? 0)}
                </text>
              ) : null}
              <text
                x={point.x}
                y={bottom + 34}
                textAnchor="middle"
                fill={active ? "var(--color-muted-foreground)" : "var(--color-muted-foreground)"}
                fontSize="20"
                fontWeight="600"
              >
                {day.day}
              </text>
            </g>
          );
        })}

      </svg>
      <div
        className="pointer-events-none absolute"
        style={{
          left: `${(truckPoint.x / width) * 100}%`,
          top: `${(truckPoint.y / height) * 100}%`,
          transform: "translate(-48%, -70%)",
        }}
      >
        <TruckGlyph color={truckColor} className={compact ? "h-10 w-20" : "h-14 w-28"} />
      </div>
    </div>
  );
}

function moneyLabel(value: number) {
  return `$${value.toLocaleString()}`;
}

const COLOR_KEY = "ez-truck-color";
const DEFAULT_COLOR = TRUCK_COLORS[0]!.value;

/** Picture picker selection — visual only, persisted in the browser. */
const BODY_KEY = "ez-truck-body";
export const DEFAULT_BODY = "semi";

export const TRUCK_BODY_IMAGES = {
  bobtail: bobtailAsset.url,
  semi: copilotAvatarAsset.url,
  van: vanAsset.url,
  flatbedSemi: flatbedSemiAsset.url,
  flatbed: flatbedAsset.url,
  lowboy: lowboyAsset.url,
  gooseneck: gooseneckAsset.url,
} as const;

export function truckBodyImage(body: string) {
  if (body in TRUCK_BODY_IMAGES) {
    return TRUCK_BODY_IMAGES[body as keyof typeof TRUCK_BODY_IMAGES];
  }
  return goalTruckAsset.url;
}

export function useTruckBody() {
  const [body, setBodyState] = useState(DEFAULT_BODY);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(BODY_KEY);
      if (stored) setBodyState(stored);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  const setBody = useCallback((value: string) => {
    setBodyState(value);
    try {
      localStorage.setItem(BODY_KEY, value);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  return [body, setBody] as const;
}

/** Small round portrait of the driver's picked truck — used as EZ Copilot's avatar. */
export function TruckAvatar({
  body,
  color,
  className = "size-10",
}: {
  body: string;
  color: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-surface-2 ${className}`}
      style={{ boxShadow: `0 0 12px ${color}55` }}
    >
      <img
        src={truckBodyImage(body)}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="h-full w-full select-none object-cover"
      />
    </span>
  );
}

/**
 * EZ Copilot's face — the same picture everywhere Copilot speaks.
 * The picked color only lights the ring/glow; the picture is never recolored.
 */
export function CopilotAvatar({
  color,
  className = "size-10",
}: {
  color: string;
  className?: string;
}) {
  const [body] = useTruckBody();
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ${className}`}
      style={{ border: `1px solid ${color}80`, boxShadow: `0 0 12px ${color}66` }}
    >
      <img
        src={truckBodyImage(body)}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="h-full w-full select-none object-cover"
      />
    </span>
  );
}

export function useTruckColor() {
  const [color, setColorState] = useState(DEFAULT_COLOR);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(COLOR_KEY);
      if (stored) setColorState(stored);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  const setColor = useCallback((value: string) => {
    setColorState(value);
    try {
      localStorage.setItem(COLOR_KEY, value);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

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
