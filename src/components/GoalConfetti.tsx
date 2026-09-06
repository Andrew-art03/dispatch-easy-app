import { useEffect, useRef } from "react";

const COLORS = ["#FFB020", "#FFD37A", "#3DDC84", "#F4F4F5"];

type Piece = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rotation: number;
  spin: number;
};

export function GoalConfetti({ onDone }: { onDone?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onDone?.();
      return;
    }

    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const bounds = canvas.getBoundingClientRect();
      canvas.width = bounds.width * ratio;
      canvas.height = bounds.height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();

    const width = canvas.getBoundingClientRect().width;
    const pieces: Piece[] = Array.from({ length: 72 }, (_, index) => ({
      x: width * (0.35 + Math.random() * 0.3),
      y: 130 + Math.random() * 20,
      vx: (Math.random() - 0.5) * 8,
      vy: -5 - Math.random() * 7,
      size: 4 + Math.random() * 5,
      color: COLORS[index % COLORS.length] ?? COLORS[0],
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.25,
    }));
    const started = performance.now();
    let frame = 0;

    const draw = (now: number) => {
      const elapsed = now - started;
      context.clearRect(0, 0, canvas.width, canvas.height);
      for (const piece of pieces) {
        piece.x += piece.vx;
        piece.y += piece.vy;
        piece.vy += 0.22;
        piece.rotation += piece.spin;
        context.save();
        context.translate(piece.x, piece.y);
        context.rotate(piece.rotation);
        context.fillStyle = piece.color;
        context.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2);
        context.restore();
      }
      if (elapsed < 1800) {
        frame = requestAnimationFrame(draw);
      } else {
        onDone?.();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [onDone]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 h-full w-full"
    />
  );
}