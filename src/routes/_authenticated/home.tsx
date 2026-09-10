import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  Clock,
  FileText,
  LayoutList,
  Search,
  Settings,
  Wallet,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { AppShell, ErrorBox } from "@/components/AppShell";
import { GoalBar, useTruckColor } from "@/components/GoalProgress";
import { useEZVoice } from "@/components/EZVoice";
import type { LoadState } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/home")({
  head: () => ({
    meta: [
      { title: "Home — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content:
          "One screen with your week's pay, loads waiting on you, hunting, hours, paperwork and EZ Copilot.",
      },
      { property: "og:title", content: "Home — EZ Trucking Auto Dispatching" },
      {
        property: "og:description",
        content: "Your week's pay, loads, hunting, hours and paperwork in one screen.",
      },
    ],
  }),
  component: HomePage,
});

// Weekly payout goal figures match the Board card (design-phase values).
const WEEK = { earned: 2100, target: 3000 };

const NEEDS_YOU: LoadState[] = ["qualified", "terms_proposed", "rate_con_received"];
const LOOKING: LoadState[] = ["candidate_found", "qualified"];

type Tone = "neutral" | "good" | "caution" | "blocked";

const TONE_BORDER: Record<Tone, string> = {
  neutral: "border-border",
  good: "border-ez-green/45",
  caution: "border-ez-amber/45",
  blocked: "border-ez-red/50",
};

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  good: "text-ez-green",
  caution: "text-ez-amber",
  blocked: "text-ez-red",
};

function money(n: number) {
  return `$${n.toLocaleString()}`;
}

function HomePage() {
  const [truckColor] = useTruckColor();
  const voice = useEZVoice();

  const truckQuery = useQuery({
    queryKey: ["home-truck"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("truck")
        .select("unit_number, home_base_city")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as { unit_number: string | null } | null) ?? null;
    },
  });

  const loadsQuery = useQuery({
    queryKey: ["home-loads"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("load")
        .select("id, state, reference")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as { id: string; state: LoadState; reference: string | null }[];
    },
  });

  const huntQuery = useQuery({
    queryKey: ["home-hunt"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("hunt")
        .select("active, origin_city, dest_states, home_by")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as {
        active: boolean | null;
        origin_city: string | null;
        dest_states: string[] | null;
        home_by: string | null;
      } | null) ?? null;
    },
  });

  const driverQuery = useQuery({
    queryKey: ["home-driver"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("driver")
        .select("hos_hours_left")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as { hos_hours_left: number | null } | null) ?? null;
    },
  });

  const docsQuery = useQuery({
    queryKey: ["home-docs"],
    queryFn: async () => {
      const [loads, docs] = await Promise.all([
        supabase.from("load").select("id, state").limit(200),
        supabase.from("document").select("load_id, type").limit(500),
      ]);
      if (loads.error) throw loads.error;
      if (docs.error) throw docs.error;
      const rows = (docs.data ?? []) as { load_id: string | null; type: string }[];
      const have = (id: string, type: string) =>
        rows.some((d) => d.load_id === id && d.type === type);
      let missing = 0;
      for (const l of (loads.data ?? []) as { id: string; state: LoadState }[]) {
        const needsRateCon = !have(l.id, "rate_con");
        const needsPod = l.state === "delivered" && !have(l.id, "pod");
        if (needsRateCon || needsPod) missing += 1;
      }
      return { missing, total: (loads.data ?? []).length };
    },
  });

  const loads = loadsQuery.data ?? [];
  const needsYou = loads.filter((l) => NEEDS_YOU.includes(l.state)).length;
  const looking = loads.filter((l) => LOOKING.includes(l.state)).length;
  const unit = truckQuery.data?.unit_number;
  const progress = WEEK.earned / WEEK.target;

  const hunt = huntQuery.data;
  const direction =
    hunt?.dest_states && hunt.dest_states.length > 0
      ? hunt.dest_states.slice(0, 4).join(", ")
      : "anywhere EZ finds pay";
  const homeBy = hunt?.home_by
    ? new Date(hunt.home_by).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    : null;

  const hours = driverQuery.data?.hos_hours_left;

  return (
    <AppShell
      title="Home"
      action={
        <Link
          to="/settings"
          aria-label="Settings"
          className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-border bg-card"
        >
          <Settings className="size-5 text-muted-foreground" />
        </Link>
      }
    >
      <div className="space-y-2">
        {/* 1 — Weekly payout goal */}
        <Link to="/goal" className="mb-4 block rounded-md border border-ez-amber/40 bg-card p-4">
          <span className="ez-label flex items-center gap-2 text-muted-foreground">
            <Wallet className="size-4 text-ez-amber" />
            Your weekly payout goal
          </span>
          <p className="ez-hero-number mt-4">
            {money(WEEK.earned)}{" "}
            <span className="block pt-3 text-xl text-muted-foreground">of {money(WEEK.target)}</span>
          </p>
          <div className="mt-8">
            <GoalBar progress={progress} truckColor={truckColor} />
          </div>
          <p className="mt-2 font-mono text-xs text-ez-amber">
            {money(WEEK.target - WEEK.earned)} to go this week
          </p>
        </Link>

        {/* 2 — Board */}
        <HomeCard
          to="/board"
          icon={<LayoutList className="size-5 text-ez-amber" />}
          title="Board"
          status={
            loadsQuery.isPending
              ? "Loading your loads…"
              : loads.length === 0
                ? "No loads yet — paste one in Hunt"
                : `${unit ? `Unit ${unit} · ` : ""}${looking} to look at · Needs you: ${needsYou}`
          }
          error={loadsQuery.error}
          tone={loadsQuery.isPending ? "neutral" : needsYou > 0 ? "caution" : "good"}
        />

        {/* 3 — Hunt */}
        <HomeCard
          to="/hunt"
          icon={<Search className="size-5 text-ez-amber" />}
          title="Hunt"
          status={
            huntQuery.isPending
              ? "Loading…"
              : !hunt
                ? "Hunting is off — set your trip and direction"
                : `Hunting is ${hunt.active ? "ON" : "OFF"} · heading ${direction}${
                    homeBy ? ` · home by ${homeBy}` : ""
                  }`
          }
          error={huntQuery.error}
          tone={huntQuery.isPending ? "neutral" : hunt?.active ? "good" : "caution"}
        />

        {/* 4 — Hours */}
        <HomeCard
          to="/settings"
          icon={<Clock className="size-5 text-ez-amber" />}
          title="Hours"
          status={
            driverQuery.isPending
              ? "Loading…"
              : hours == null
                ? "No hours entered — add them in Settings"
                : `${hours} hours left to drive`
          }
          hint="Your numbers, not your log."
          error={driverQuery.error}
          tone={driverQuery.isPending ? "neutral" : hours == null ? "caution" : "good"}
        />

        {/* 5 — Docs */}
        <HomeCard
          to="/docs"
          icon={<FileText className="size-5 text-ez-amber" />}
          title="Docs"
          status={
            docsQuery.isPending
              ? "Loading…"
              : (docsQuery.data?.total ?? 0) === 0
                ? "Nothing to file yet"
                : docsQuery.data!.missing === 0
                  ? "All paperwork is in"
                  : `${docsQuery.data!.missing} load${docsQuery.data!.missing === 1 ? "" : "s"} missing a rate con or POD`
          }
          error={docsQuery.error}
          tone={
            docsQuery.isPending || (docsQuery.data?.total ?? 0) === 0
              ? "neutral"
              : docsQuery.data!.missing === 0
                ? "good"
                : "caution"
          }
        />

        {/* 6 — EZ Copilot */}
        <section className="mt-4 rounded-md border border-ez-amber/50 bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="min-w-0">
              <p className="ez-card-title">EZ Copilot</p>
              <p className="truncate text-sm text-muted-foreground">
                {unit ? `Unit ${unit}` : "No truck yet"} · ask for your next move
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-3">
            <button
              type="button"
              onClick={() =>
                voice.openWith({
                  transcript: "How can I help you today?",
                  heard: [
                    { label: "Truck", value: unit ? `Unit ${unit}` : "No truck yet", sure: true },
                    { label: "Action", value: "Find my next load", sure: false },
                  ],
                  keepAmount: "$1,412",
                  rpmLabel: "$2.41",
                  verdictWord: "Take it",
                })
              }
              className="rounded-md border border-ez-amber px-4 py-3 text-sm font-semibold text-ez-amber"
            >
              How can I help you today?
            </button>
            <Link to="/copilot" className="ez-btn-secondary text-center">
              Work with EZ Copilot
            </Link>
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function HomeCard({
  to,
  icon,
  title,
  status,
  hint,
  error,
  tone = "neutral",
}: {
  to: string;
  icon: ReactNode;
  title: string;
  status: string;
  hint?: string;
  error?: unknown;
  tone?: Tone;
}) {
  return (
    <Link to={to} className={`block rounded-md border bg-card p-4 ${TONE_BORDER[tone]}`}>
      <div className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="ez-card-title">{title}</p>
          <p className={`text-sm ${TONE_TEXT[tone]}`}>{status}</p>
          {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <span aria-hidden="true" className="text-muted-foreground">
          →
        </span>
      </div>
      {error ? (
        <div className="mt-3">
          <ErrorBox error={error} />
        </div>
      ) : null}
    </Link>
  );
}
