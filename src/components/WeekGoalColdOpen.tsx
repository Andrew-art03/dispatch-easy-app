import { useEffect, useMemo, useRef, useState } from "react";
import truckAsset from "@/assets/ez-18wheeler-side.png.asset.json";

/**
 * Week Goal cold open (F-09) — direct port of ez-week-goal-coldopen.html.
 *
 * Three acts on one timeline: APPROACH (the side-profile photo rotated in 3D
 * under perspective so the nose faces camera), TURN (the same element rotates
 * back to 0deg while the camera pulls back), CLIMB (the truck follows the road
 * path with getPointAtLength()). No animation or chart library.
 *
 * Everything derives from props — no money is hard-coded in here.
 */

export type ColdOpenDay = { label: string; amountCents: number };

export type WeekGoalColdOpenProps = {
  goalCents: number;
  days: ColdOpenDay[];
  /** True when the figures are sample data, not the driver's own money. */
  isFixture?: boolean;
  onContinue?: () => void;
  ctaLabel?: string;
};

const VB = { w: 400, h: 238 };
const APPROACH = 900;
const TURN = 1100;
const CLIMB = 1500;
const ANGLE = 58;
/** Truck width on the road, in px, and the axle contact point on the asset. */
const TRUCK_W = 78;
const AXLE_X = 0.28;
const AXLE_Y = 0.86;
const AXLE_OFFSET = `translate(${-AXLE_X * 100}%, ${-AXLE_Y * 100}%)`;


const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

type Road = {
  d: string;
  areaD: string;
  pts: { x: number; y: number }[];
  base: number;
  goalY: number;
  cum: number[];
  earned: number;
  lastIdx: number;
  labelX: number[];
  labelY: number[];
};

/** The road = the week adding up. Monotonic, so it always climbs. */
function buildRoad(goalCents: number, days: ColdOpenDay[]): Road {
  const cum: number[] = [];
  days.reduce((a, day, i) => (cum[i] = a + Math.max(0, day.amountCents)), 0);
  const earned = cum.length ? cum[cum.length - 1]! : 0;
  const ceiling = Math.max(goalCents, earned, 1) * 1.06;
  const L = 34;
  const R = VB.w - 26;
  const base = VB.h - 30;
  const top = 42;
  const stepX = (R - L) / Math.max(days.length, 1);
  const Y = (v: number) => base - (v / ceiling) * (base - top);
  const pts: { x: number; y: number }[] = [
    { x: L - 30, y: base },
    { x: L, y: base },
  ];
  cum.forEach((v, i) => pts.push({ x: L + (i + 1) * stepX, y: Y(v) }));

  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const mx = (a.x + b.x) / 2;
    d += ` C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
  }
  const last = pts[pts.length - 1]!;
  const areaD = `${d} L ${last.x} ${base + 40} L ${pts[0]!.x} ${base + 40} Z`;

  let lastIdx = 0;
  days.forEach((day, i) => {
    if (day.amountCents > 0) lastIdx = i;
  });

  return {
    d,
    areaD,
    pts,
    base,
    goalY: Y(goalCents),
    cum,
    earned,
    lastIdx,
    labelX: cum.map((_, i) => L + (i + 1) * stepX),
    labelY: cum.map((v) => Y(v) - 26),
  };
}

export function WeekGoalColdOpen({
  goalCents: goalProp,
  days: daysProp,
  isFixture = false,
  onContinue,
  ctaLabel = "Continue",
}: WeekGoalColdOpenProps) {
  // Dev-only overrides drive the harness below; drivers never see them.
  const [devGoal, setDevGoal] = useState<number | null>(null);
  const [devDays, setDevDays] = useState<number[] | null>(null);
  const goalCents = import.meta.env.DEV && devGoal !== null ? devGoal : goalProp;
  const days = useMemo(
    () =>
      import.meta.env.DEV && devDays
        ? daysProp.map((d, i) => ({ ...d, amountCents: devDays[i] ?? d.amountCents }))
        : daysProp,
    [daysProp, devDays],
  );
  const road = useMemo(() => buildRoad(goalCents, days), [goalCents, days]);
  const cleared = road.earned >= goalCents;
  const remaining = goalCents - road.earned;
  const [settled, setSettled] = useState(false);
  const [replayKey, setReplayKey] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const rigRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const dustRef = useRef<HTMLDivElement>(null);
  const flareRef = useRef<HTMLDivElement>(null);
  const lampLRef = useRef<HTMLDivElement>(null);
  const lampRRef = useRef<HTMLDivElement>(null);
  const streakRef = useRef<HTMLDivElement>(null);
  const approachRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const roadBedRef = useRef<SVGPathElement>(null);
  const revealRef = useRef<SVGRectElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const cumRefs = useRef<(SVGTextElement | null)[]>([]);

  useEffect(() => {
    const stage = stageRef.current;
    const scene = sceneRef.current;
    const rig = rigRef.current;
    const art = artRef.current;
    const roadBed = roadBedRef.current;
    if (!stage || !scene || !rig || !art || !roadBed) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const frames: number[] = [];
    const after = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
    const raf = (fn: FrameRequestCallback) => frames.push(requestAnimationFrame(fn));
    const sx = () => stage.clientWidth / VB.w;
    const sy = () => stage.clientHeight / VB.h;
    let counterValue = 0;

    /** #truck-rig: 2D only. The path point IS the position. */
    const putRig = (x: number, y: number, deg: number) => {
      rig.style.transform = `translate(${x}px,${y}px) rotate(${deg}deg)`;
    };
    /** #scene: camera only — never rotates. */
    const putCamera = (tx: number, ty: number, k: number) => {
      scene.style.transform = `translate(${tx}px,${ty}px) scale(${k})`;
    };
    /** #truck-art: 3D yaw only, and only during acts 1-2. */
    const putYaw = (deg: number | null) => {
      // The constant axle-alignment offset is never animated; only the yaw is.
      art.style.transform =
        deg === null ? AXLE_OFFSET : `${AXLE_OFFSET} rotateY(${deg}deg)`;
    };

    const len = roadBed.getTotalLength();
    const tangentAt = (l: number) => {
      const p = roadBed.getPointAtLength(l);
      const p2 = roadBed.getPointAtLength(Math.min(l + 1, len));
      const ax = p.x * sx();
      const ay = p.y * sy();
      const bx = p2.x * sx();
      const by = p2.y * sy();
      return { x: ax, y: ay, deg: (Math.atan2(by - ay, bx - ax) * 180) / Math.PI };
    };

    rig.style.width = `${TRUCK_W}px`;
    const startL = len * 0.012;
    const startPose = tangentAt(startL);

    const setCount = (cents: number) => {
      if (countRef.current) countRef.current.textContent = usd(cents);
    };

    const countTo = (v: number) => {
      const from = counterValue;
      counterValue = v;
      const s0 = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - s0) / 340);
        setCount(from + (v - from) * ease(p));
        if (p < 1) raf(tick);
      };
      raf(tick);
    };

    const settle = () => {
      if (graphRef.current) graphRef.current.style.opacity = "1";
      if (approachRef.current) approachRef.current.style.opacity = "0";
      revealRef.current?.setAttribute("width", String(road.pts[road.lastIdx + 2]!.x + 3));
      cumRefs.current.forEach((t, i) => {
        if (t && days[i] && days[i]!.amountCents > 0) t.style.opacity = "1";
      });
      counterValue = road.earned;
      setCount(road.earned);
      if (flareRef.current) flareRef.current.style.opacity = "0";
      if (dustRef.current) dustRef.current.style.opacity = "0";
      if (glowRef.current) glowRef.current.style.opacity = cleared ? "0.9" : "0.45";
      setSettled(true);
    };

    // Reset
    setSettled(false);
    counterValue = 0;
    setCount(0);
    revealRef.current?.setAttribute("width", "0");
    cumRefs.current.forEach((t) => t && (t.style.opacity = "0"));
    scene.style.transition = "none";
    art.style.transition = "none";

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const parkPose = (() => {
      const targetX = road.pts[road.lastIdx + 2]!.x;
      let lo = 0;
      let hi = len;
      for (let i = 0; i < 26; i++) {
        const m = (lo + hi) / 2;
        if (roadBed.getPointAtLength(m).x < targetX) lo = m;
        else hi = m;
      }
      return (lo + hi) / 2;
    })();

    const floor = stage.clientHeight - 26;
    const cx = stage.clientWidth / 2;

    if (reduce) {
      putCamera(0, 0, 1);
      putYaw(null);
      const end = tangentAt(parkPose);
      putRig(end.x, end.y, end.deg);
      settle();
      return;
    }

    // The rig sits at the true path start for acts 1-2; only the camera moves.
    putRig(startPose.x, startPose.y, startPose.deg);
    scene.style.transformOrigin = `${startPose.x}px ${startPose.y}px`;

    if (graphRef.current) graphRef.current.style.opacity = "0";
    if (approachRef.current) {
      approachRef.current.style.opacity = "1";
      approachRef.current.classList.add("rolling");
    }
    if (flareRef.current) flareRef.current.style.opacity = "1";

    const bigK = (stage.clientWidth * 0.66) / TRUCK_W;
    const smallK = 20 / TRUCK_W;
    const HORIZON = 102;
    const t0 = performance.now();
    putYaw(ANGLE);
    putCamera(cx - startPose.x, HORIZON - startPose.y, smallK);

    // ACT 1 — approach out of the vanishing point. Camera + yaw only.
    const drive = (now: number) => {
      const p = Math.min(1, (now - t0) / APPROACH);
      const e = Math.pow(p, 2.1);
      const k = smallK + e * (bigK - smallK);
      const w = TRUCK_W * k;
      const sway = Math.sin(p * Math.PI * 2.2) * (1 - p) * 12;
      const bob = Math.sin(p * Math.PI * 9) * (0.6 + e * 2.2);
      const y = HORIZON + (floor - 8 - HORIZON) * e + bob;
      putCamera(cx + sway - startPose.x, y - startPose.y, k);

      const lampY = y - w * 0.145;
      const gap = w * 0.03;
      const noseX = cx + sway + w * 0.2;
      const size = 5 + e * 46;
      [
        [lampLRef.current, -1],
        [lampRRef.current, 1],
      ].forEach(([el, s2]) => {
        const lamp = el as HTMLDivElement | null;
        if (!lamp) return;
        lamp.style.width = `${size}px`;
        lamp.style.height = `${size}px`;
        lamp.style.left = `${noseX + (s2 as number) * gap}px`;
        lamp.style.top = `${lampY}px`;
        lamp.style.opacity = (0.55 + e * 0.45).toFixed(2);
      });
      if (streakRef.current) {
        streakRef.current.style.left = `${noseX}px`;
        streakRef.current.style.top = `${lampY}px`;
        streakRef.current.style.width = `${w * 0.8}px`;
        streakRef.current.style.opacity = (0.18 + e * 0.42).toFixed(2);
      }
      if (glowRef.current) glowRef.current.style.opacity = (e * 0.45).toFixed(2);
      if (p < 1) raf(drive);
    };
    raf(drive);

    // ACT 2 — the handoff. One continuous unwind of the yaw while the camera
    // pulls back to identity, so the rig ends exactly on the path start.
    after(APPROACH, () => {
      approachRef.current?.classList.remove("rolling");
      const eased = `${TURN}ms cubic-bezier(.42,.02,.24,1)`;
      scene.style.transition = `transform ${eased}`;
      art.style.transition = `transform ${eased}`;
      putCamera(0, 0, 1);
      putYaw(0);
      if (flareRef.current) {
        flareRef.current.style.transition = "opacity .34s linear";
        flareRef.current.style.opacity = "0";
      }
      after(Math.round(TURN * 0.4), () => {
        if (approachRef.current) approachRef.current.style.opacity = "0";
        if (graphRef.current) graphRef.current.style.opacity = "1";
      });
    });

    // ACT 3 — climb. Only the rig moves, straight off the path geometry.
    after(APPROACH + TURN, () => {
      // Hard snap: kill every leftover transform and land on the path start.
      scene.style.transition = "none";
      art.style.transition = "none";
      putCamera(0, 0, 1);
      putYaw(null);
      putRig(startPose.x, startPose.y, startPose.deg);

      const s0 = performance.now();
      let lit = -1;

      const roll = (now: number) => {
        const p = Math.min(1, (now - s0) / CLIMB);
        const e = ease(p);
        const l = startL + (parkPose - startL) * e;
        const pose = tangentAt(l);
        putRig(pose.x, pose.y, pose.deg);

        const pt = roadBed.getPointAtLength(l);
        const dust = dustRef.current;
        if (dust) {
          dust.style.left = `${pose.x - TRUCK_W * 0.24}px`;
          dust.style.top = `${pose.y + 2}px`;
          dust.style.opacity = (0.1 + Math.abs(Math.sin(p * Math.PI * 5)) * 0.16).toFixed(2);
          dust.style.width = `${24 + Math.abs(Math.sin(p * Math.PI * 3)) * 22}px`;
        }
        revealRef.current?.setAttribute("width", (pt.x + 3).toFixed(1));
        if (glowRef.current)
          glowRef.current.style.opacity = (0.4 + Math.abs(Math.sin(p * Math.PI * 3)) * 0.35).toFixed(2);

        for (let i = lit + 1; i < days.length; i++) {
          if (days[i]!.amountCents > 0 && pt.x >= road.pts[i + 2]!.x + 30) {
            const t = cumRefs.current[i];
            if (t) {
              t.style.transition = "opacity .2s";
              t.style.opacity = "1";
            }
            countTo(road.cum[i]!);
            lit = i;
          } else break;
        }

        if (p < 1) return raf(roll);
        settle();
        return undefined;
      };
      raf(roll);
    });

    return () => {
      timers.forEach(clearTimeout);
      frames.forEach(cancelAnimationFrame);
    };
  }, [road, days, cleared, replayKey]);


  const accent = cleared ? "#FFC24A" : "var(--ez-amber)";
  const monoLabel = "font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground";

  return (
    <div
      className="w-full"
      style={{ ["--acc" as string]: accent }}
    >
      <div className="mx-auto w-full max-w-[420px] overflow-hidden rounded-lg border border-border">
        <header className="overflow-hidden px-3.5 pb-1 pt-5 text-center">
          <div className="mb-4 flex items-center justify-center gap-3">
            <span
              className="grid size-[38px] place-items-center rounded-full font-condensed text-lg font-bold"
              style={{ background: accent, color: "#0B0B0F" }}
            >
              EZ
            </span>
            <span className="font-condensed text-2xl font-bold uppercase tracking-[0.16em]">
              EZ Trucking
            </span>
          </div>
          <p className={monoLabel}>Weekly payout goal</p>
          <h1 className="ez-num mt-1.5 whitespace-nowrap font-condensed text-[clamp(26px,9vw,42px)] font-bold leading-[1.05]">
            <span ref={countRef}>{usd(road.earned)}</span>{" "}
            <span className="text-muted-foreground">of {usd(goalCents)}</span>
          </h1>
          <p className="mt-1.5 min-h-[15px] font-mono text-[11px] text-muted-foreground">
            {cleared ? (
              <span style={{ color: "var(--ez-green)" }}>
                Goal cleared by {usd(-remaining)} — you did it.
              </span>
            ) : (
              <>
                {usd(remaining)} to go ·{" "}
                <span style={{ color: accent }}>one more load gets you there</span>
              </>
            )}
          </p>
          {isFixture ? (
            <span className="mt-2 inline-block rounded-[4px] border border-border px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
              Sample
            </span>
          ) : null}
        </header>

        <div
          ref={stageRef}
          aria-hidden="true"
          className="ez-coldopen-stage relative mx-4 my-3.5 h-[238px] overflow-hidden rounded-lg border border-border bg-card"
        >
          {/* ACT 1 backdrop: perspective road rushing toward the viewer */}
          <div ref={approachRef} className="ez-coldopen-layer absolute inset-0">
            <svg viewBox="0 0 400 238" preserveAspectRatio="none" className="block size-full">
              <defs>
                <linearGradient id="coAsphalt" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#1A1B20" stopOpacity="0" />
                  <stop offset="1" stopColor="#24262D" />
                </linearGradient>
                <linearGradient id="coEdge" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" style={{ stopColor: accent }} stopOpacity="0" />
                  <stop offset="1" style={{ stopColor: accent }} stopOpacity=".55" />
                </linearGradient>
              </defs>
              <polygon points="200,84 170,84 -40,238 440,238 230,84" fill="url(#coAsphalt)" />
              <line x1="200" y1="86" x2="-30" y2="238" stroke="url(#coEdge)" strokeWidth="2.5" />
              <line x1="200" y1="86" x2="430" y2="238" stroke="url(#coEdge)" strokeWidth="2.5" />
              <g className="ez-coldopen-dashes" stroke="url(#coEdge)" strokeWidth="5" strokeLinecap="round">
                {(() => {
                  const lines: React.ReactElement[] = [];
                  let y = 90;
                  for (let i = 0; i < 8; i++) {
                    const h = 3 + i * 2.4;
                    lines.push(<line key={i} x1="200" y1={y} x2="200" y2={y + h} />);
                    y += h + 5 + i * 2.2;
                  }
                  return lines;
                })()}
              </g>
            </svg>
          </div>

          {/* ACT 3 backdrop: the week's money as a road */}
          <div ref={graphRef} className="ez-coldopen-layer absolute inset-0 opacity-0">
            <svg viewBox="0 0 400 238" preserveAspectRatio="none" className="block size-full">
              <defs>
                <linearGradient id="coFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" style={{ stopColor: accent }} stopOpacity=".38" />
                  <stop offset="1" style={{ stopColor: accent }} stopOpacity=".02" />
                </linearGradient>
                <clipPath id="coReveal">
                  <rect ref={revealRef} x="0" y="0" width="0" height="238" />
                </clipPath>
              </defs>
              <line
                x1="0"
                x2="400"
                y1={road.goalY}
                y2={road.goalY}
                style={{ stroke: accent }}
                strokeWidth="1"
                strokeDasharray="3 6"
                opacity=".5"
              />
              <text
                x="392"
                y={road.goalY - 5}
                textAnchor="end"
                className="font-mono"
                style={{ fill: accent, fontSize: 9, letterSpacing: "0.14em" }}
              >
                GOAL
              </text>
              <path d={road.areaD} fill="url(#coFill)" clipPath="url(#coReveal)" />
              <path
                d={road.d}
                fill="none"
                stroke="rgba(255,255,255,.07)"
                strokeWidth="5"
                strokeLinecap="round"
                strokeDasharray="5 11"
              />
              <path
                ref={roadBedRef}
                d={road.d}
                fill="none"
                stroke="#24262D"
                strokeWidth="12"
                strokeLinecap="round"
                clipPath="url(#coReveal)"
              />
              <path
                d={road.d}
                fill="none"
                style={{ stroke: accent }}
                strokeWidth="1.5"
                strokeDasharray="6 9"
                strokeLinecap="round"
                opacity=".9"
                clipPath="url(#coReveal)"
              />
              <g>
                {days.map((day, i) => (
                  <text
                    key={`lbl-${day.label}`}
                    x={road.labelX[i]}
                    y={road.base + 16}
                    textAnchor="middle"
                    className="font-mono"
                    style={{ fill: "#8B9099", fontSize: 9, letterSpacing: "0.08em" }}
                  >
                    {day.label}
                  </text>
                ))}
                {days.map((day, i) => (
                  <text
                    key={`cum-${day.label}`}
                    ref={(el) => {
                      cumRefs.current[i] = el;
                    }}
                    x={road.labelX[i]}
                    y={road.labelY[i]}
                    textAnchor="middle"
                    className="font-mono"
                    style={{ fill: "#F4F5F7", fontSize: 9, opacity: 0 }}
                  >
                    {day.amountCents > 0 ? usd(road.cum[i]!) : ""}
                  </text>
                ))}
              </g>
            </svg>
          </div>

          <div ref={dustRef} className="ez-coldopen-dust" />
          <div ref={flareRef} className="ez-coldopen-flare">
            <div ref={lampLRef} className="ez-coldopen-lamp" />
            <div ref={lampRRef} className="ez-coldopen-lamp" />
            <div ref={streakRef} className="ez-coldopen-streak" />
          </div>

          {/* ONE truck for the whole film — the repo's side-profile photo, facing right. */}
          <div ref={sceneRef} className="ez-coldopen-scene">
            <div ref={rigRef} className="ez-coldopen-rig">
              <div ref={artRef} className="ez-coldopen-art">
                <img src={truckAsset.url} alt="" className="ez-coldopen-truck" draggable={false} />
                <div ref={glowRef} className="ez-coldopen-glow" style={{ background: `radial-gradient(ellipse at center, ${accent}, transparent 70%)` }} />
              </div>
            </div>
          </div>

        </div>

        <button
          type="button"
          onClick={onContinue}
          className="mx-4 mb-4 h-[52px] w-[calc(100%-2rem)] rounded-lg font-condensed text-[17px] font-bold uppercase tracking-[0.08em] transition-opacity duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{
            background: "var(--ez-amber)",
            color: "#0B0B0F",
            opacity: settled ? 1 : 0,
            pointerEvents: settled ? "auto" : "none",
          }}
        >
          {ctaLabel}
        </button>
      </div>

      {import.meta.env.DEV ? (
        <DevPanel
          goalCents={goalCents}
          days={days}
          onGoal={setDevGoal}
          onDay={(i, cents) =>
            setDevDays((current) => {
              const next = current ? [...current] : days.map((d) => d.amountCents);
              next[i] = cents;
              return next;
            })
          }
          onReplay={() => setReplayKey((k) => k + 1)}
        />
      ) : null}
    </div>
  );
}

/** Dev-only harness (goal + day inputs + Replay). Never rendered for drivers. */
function DevPanel({
  goalCents,
  days,
  onGoal,
  onDay,
  onReplay,
}: {
  goalCents: number;
  days: ColdOpenDay[];
  onGoal: (cents: number) => void;
  onDay: (index: number, cents: number) => void;
  onReplay: () => void;
}) {
  const field =
    "w-[72px] rounded-[4px] border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground";
  const label = "flex flex-col gap-1 font-mono text-[10px] text-muted-foreground";
  return (
    <div className="mx-auto mt-4 w-full max-w-[420px] rounded-lg border border-border bg-card p-4">
      <h2 className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        Dev only — real numbers drive it
      </h2>
      <div className="flex flex-wrap items-end gap-2">
        <label className={label}>
          GOAL $
          <input
            className={field}
            type="number"
            step={100}
            defaultValue={Math.round(goalCents / 100)}
            onChange={(e) => onGoal(Math.max(100, Math.round(Number(e.target.value) || 0) * 100))}
          />
        </label>
        {days.map((day, i) => (
          <label key={day.label} className={label}>
            {day.label}
            <input
              className={field}
              type="number"
              step={50}
              defaultValue={Math.round(day.amountCents / 100)}
              onChange={(e) => onDay(i, Math.max(0, Math.round(Number(e.target.value) || 0) * 100))}
            />
          </label>
        ))}
        <button
          type="button"
          onClick={onReplay}
          className="rounded-[6px] border px-3.5 py-2 font-mono text-[10.5px] uppercase tracking-[0.12em]"
          style={{ borderColor: "var(--ez-amber)", color: "var(--ez-amber)" }}
        >
          Replay
        </button>
      </div>
    </div>
  );
}

