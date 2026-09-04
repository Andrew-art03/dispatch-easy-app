import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { AppShell, Empty, ErrorBox, Loading } from "@/components/AppShell";
import type { LoadState, LoadWithRelations, Score } from "@/lib/types";
import { latestScore, money, routeLabel, rpm, VERDICT_LABEL } from "@/lib/load-utils";
import { EZStatusLine, EZVoiceSheet } from "@/components/EZVoice";
import { GoalGlanceCard, useTruckColor } from "@/components/GoalProgress";
import boardTruckFogAsset from "@/assets/board-truck-fog.jpg.asset.json";

// Visual-only mock for the week goal glance (design pass).
const GOAL_MOCK = { earned: 3400, target: 6000 };

export const Route = createFileRoute("/_authenticated/board")({
  head: () => ({
    meta: [
      { title: "Load board — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content: "Every load your truck is working, grouped from found to delivered, with true net and a take or skip call.",
      },
      { property: "og:title", content: "Load board — EZ Trucking Auto Dispatching" },
      {
        property: "og:description",
        content: "Every load your truck is working, from found to delivered, with true net and a verdict.",
      },
    ],
  }),
  component: BoardPage,
});

const GROUPS: { state: LoadState; label: string }[] = [
  { state: "candidate_found", label: "Found" },
  { state: "qualified", label: "Qualified" },
  { state: "booked", label: "Booked" },
  { state: "in_transit", label: "Rolling" },
  { state: "delivered", label: "Delivered" },
];

function BoardPage() {
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [truckColor] = useTruckColor();

  const query = useQuery({
    queryKey: ["board"],
    queryFn: async (): Promise<LoadWithRelations[]> => {
      const { data, error } = await supabase
        .from("load")
        .select("*, stop(*), score(*)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as LoadWithRelations[];
    },
  });

  const truckQuery = useQuery({
    queryKey: ["board-truck"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("truck")
        .select("unit_number")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as { unit_number: string } | null;
    },
  });

  const loads = query.data ?? [];
  const best = [...loads]
    .filter((l) => latestScore(l.score))
    .sort(
      (a, b) => (latestScore(b.score)?.true_net ?? 0) - (latestScore(a.score)?.true_net ?? 0),
    )[0];
  const bestScore = best ? latestScore(best.score) : null;
  const needsYou = loads.filter(
    (l) => l.state === "rate_con_received" || l.state === "terms_proposed",
  ).length;
  const unit = truckQuery.data?.unit_number;
  const firstStop = best?.stop?.slice().sort((a, b) => a.seq - b.seq)[0];

  return (
    <AppShell
      title="Board"
      action={
        <button
          onClick={() => setVoiceOpen(true)}
          className="min-h-11 rounded-xl border border-ez-amber px-4 text-sm font-semibold text-ez-amber"
        >
          Talk to EZ
        </button>
      }
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-lg font-semibold">Morning, driver</p>
          <p className="truncate text-sm text-muted-foreground">
            {unit
              ? `Unit ${unit} is ${firstStop ? `empty in ${firstStop.city ?? "the yard"}` : "waiting on a load"}`
              : "Add your truck to get sharper numbers"}
          </p>
        </div>
        <span className="rounded-full border border-border px-3 py-1 text-sm">
          Needs you · {needsYou}
        </span>
      </div>

      {!unit ? (
        <div className="relative mb-4 overflow-hidden rounded-2xl border border-border">
          <img
            src={boardTruckFogAsset.url}
            alt="Chrome semi truck with headlights on, rolling through fog"
            className="h-44 w-full object-cover"
            loading="lazy"
          />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background/90 to-transparent p-4 pt-10">
            <p className="font-semibold">No truck on file yet</p>
            <p className="text-sm text-muted-foreground">
              Add your truck to get sharper numbers.
            </p>
            <Link to="/truck" className="ez-btn-primary mt-3">
              Add my truck
            </Link>
          </div>
        </div>
      ) : null}

      <div className="mb-4">
        <GoalGlanceCard
          progress={GOAL_MOCK.earned / GOAL_MOCK.target}
          truckColor={truckColor}
          earned={money(GOAL_MOCK.earned)}
          target={money(GOAL_MOCK.target)}
        />
      </div>

      {query.isPending ? <Loading label="Loading your loads…" /> : null}
      {query.isError ? <ErrorBox error={query.error} onRetry={() => query.refetch()} /> : null}

      {query.data ? (
        <div className="space-y-6">
          {best ? (
            <section className="rounded-2xl border border-border bg-card p-5">
              <EZStatusLine text="EZ found your best move · high confidence · just now" />
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                EZ's best move
              </p>
              <p className="text-xl font-semibold">{routeLabel(best.stop)}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Roll out, run it straight through, drop and get paid.
              </p>

              <p className="mt-4 text-sm text-muted-foreground">You keep about</p>
              <p className="ez-num text-5xl">{money(bestScore?.true_net ?? null)}</p>
              <p className="ez-num text-lg text-muted-foreground">
                {rpm(bestScore?.all_in_rpm ?? null)} / mi
              </p>

              <ul className="mt-4 flex flex-wrap gap-4 text-sm">
                {[
                  { label: "Fits", ok: true },
                  { label: "Profit", ok: bestScore?.verdict === "take" },
                  { label: "Market", ok: false },
                ].map((d) => (
                  <li key={d.label} className="flex items-center gap-2">
                    <span
                      className={`size-2 rounded-full ${d.ok ? "bg-ez-green" : "bg-ez-amber"}`}
                    />
                    {d.label}
                  </li>
                ))}
              </ul>

              <p className="mt-4 text-sm">
                <span className="font-semibold">One thing to do:</span> confirm the plan
              </p>

              <div className="mt-4 space-y-3">
                <Link
                  to="/loads/$id"
                  params={{ id: best.id }}
                  className="ez-btn-primary"
                >
                  Review best load
                </Link>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setVoiceOpen(true)}
                    className="ez-btn-secondary text-ez-amber"
                  >
                    Talk to EZ
                  </button>
                  <Link to="/hunt" className="ez-btn-secondary">
                    See exceptions · {needsYou}
                  </Link>
                </div>
              </div>
            </section>
          ) : null}

          {GROUPS.map((group) => {
            const rows = loads.filter((l) => l.state === group.state);
            if (rows.length === 0) return null;
            return (
              <section key={group.state}>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label} · {rows.length}
                </h2>
                <ul className="space-y-2">
                  {rows.map((load) => (
                    <LoadRow key={load.id} load={load} />
                  ))}
                </ul>
              </section>
            );
          })}
          {loads.length === 0 ? (
            <Empty title="No loads yet" hint="Paste a load to get started." />
          ) : null}
        </div>
      ) : null}

      <EZVoiceSheet
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        transcript="What's my best move today?"
        heard={[
          { label: "Truck", value: unit ? `Unit ${unit}` : "Your truck", sure: true },
          { label: "Load", value: best?.reference ?? "best move", sure: true },
          { label: "Action", value: "Review this load", sure: false },
        ]}
        keepAmount={money(bestScore?.true_net ?? null)}
        rpmLabel={rpm(bestScore?.all_in_rpm ?? null)}
        verdictWord={bestScore ? VERDICT_LABEL[bestScore.verdict] : "—"}
      />
    </AppShell>
  );
}

function LoadRow({ load }: { load: LoadWithRelations }) {
  const score: Score | null = latestScore(load.score);
  return (
    <li>
      <Link
        to="/loads/$id"
        params={{ id: load.id }}
        className="block rounded-xl border border-border bg-card p-4 active:opacity-80"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="ez-ref truncate text-muted-foreground">
              {load.reference ?? "No reference"}
            </p>
            <p className="mt-0.5 truncate font-semibold">{routeLabel(load.stop)}</p>
          </div>
          {score ? (
            <span className="shrink-0 text-sm font-semibold text-muted-foreground">
              {VERDICT_LABEL[score.verdict]}
            </span>
          ) : null}
        </div>
        <p className="ez-num mt-3 text-2xl">
          {money(score?.true_net ?? null)} keep
          <span className="text-muted-foreground">
            {" "}
            · {rpm(score?.all_in_rpm ?? null)}/mi
          </span>
        </p>
      </Link>
    </li>
  );
}
