import type { Score, Stop, Verdict } from "./types";

export function money(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function rpm(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return `$${Number(value).toFixed(2)}`;
}

export function latestScore(scores: Score[] | null | undefined): Score | null {
  if (!scores || scores.length === 0) return null;
  return [...scores].sort(
    (a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
  )[0]!;
}

export function stopLabel(stop: Stop | undefined) {
  if (!stop) return "—";
  const city = [stop.city, stop.state].filter(Boolean).join(", ");
  return city || stop.address;
}

export function routeLabel(stops: Stop[] | null | undefined) {
  if (!stops || stops.length === 0) return "No stops yet";
  const sorted = [...stops].sort((a, b) => a.seq - b.seq);
  return `${stopLabel(sorted[0])} → ${stopLabel(sorted[sorted.length - 1])}`;
}

const VERDICT_STYLE: Record<Verdict, string> = {
  take: "bg-primary text-primary-foreground",
  negotiate: "bg-accent text-accent-foreground",
  skip: "bg-destructive text-destructive-foreground",
};

const VERDICT_LABEL: Record<Verdict, string> = {
  take: "Take it",
  negotiate: "Negotiate",
  skip: "Skip",
};

export function VerdictBadge({ verdict, big }: { verdict: Verdict; big?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full font-semibold ${VERDICT_STYLE[verdict]} ${
        big ? "px-4 py-2 text-base" : "px-3 py-1 text-xs"
      }`}
    >
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

export function prettyLabel(key: string) {
  return key.replace(/[_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function prettyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
