import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { AppShell, Empty, ErrorBox, Loading } from "@/components/AppShell";
import type { LoadState, LoadWithRelations, Score } from "@/lib/types";
import { latestScore, money, routeLabel, VerdictBadge } from "@/lib/load-utils";

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

  return (
    <AppShell
      title="Board"
      action={
        <Link to="/hunt" className="ez-btn-primary px-4 py-2 text-sm">
          Paste a load
        </Link>
      }
    >
      {query.isPending ? <Loading label="Loading your loads…" /> : null}
      {query.isError ? <ErrorBox error={query.error} onRetry={() => query.refetch()} /> : null}
      {query.data ? (
        <div className="space-y-6">
          {GROUPS.map((group) => {
            const rows = query.data.filter((l) => l.state === group.state);
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
          {query.data.length === 0 ? (
            <Empty title="No loads yet" hint="Paste a load to get started." />
          ) : null}
        </div>
      ) : null}
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
            <p className="truncate text-sm text-muted-foreground">
              {load.reference ?? "No reference"}
            </p>
            <p className="mt-0.5 truncate font-semibold">{routeLabel(load.stop)}</p>
          </div>
          {score ? <VerdictBadge verdict={score.verdict} /> : null}
        </div>
        <div className="mt-3 flex items-center gap-5 text-sm">
          <span>
            <span className="text-muted-foreground">Gross </span>
            <span className="font-semibold">{money(load.gross_rate)}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Net </span>
            <span className="font-semibold">{money(score?.true_net ?? null)}</span>
          </span>
        </div>
      </Link>
    </li>
  );
}
