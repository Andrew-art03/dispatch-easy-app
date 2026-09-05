import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { AppShell, Empty, ErrorBox, Loading } from "@/components/AppShell";
import type { LedgerLine } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/ledger")({
  head: () => ({
    meta: [
      { title: "Money in and out — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content: "Every dollar in and out by week: fuel, tolls, repairs and load pay, tied to the load reference.",
      },
      { property: "og:title", content: "Money in and out — EZ Trucking" },
      {
        property: "og:description",
        content: "Every dollar in and out by week, tied to the load it came from.",
      },
    ],
  }),
  component: LedgerPage,
});

function weekKey(iso: string | null) {
  if (!iso) return "No date";
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

function formatWeekLabel(key: string) {
  if (key === "No date" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  const monday = new Date(`${key}T00:00:00`);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Week of ${fmt(monday)}–${fmt(sunday)}`;
}

function money(v: number) {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function LedgerPage() {
  const query = useQuery({
    queryKey: ["ledger"],
    queryFn: async (): Promise<LedgerLine[]> => {
      const { data, error } = await supabase
        .from("ledger_line")
        .select("id, load_id, category, amount, source, at, load:load_id(reference)")
        .order("at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as LedgerLine[];
    },
  });

  const groups = new Map<string, LedgerLine[]>();
  for (const line of query.data ?? []) {
    const key = weekKey(line.at);
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }

  return (
    <AppShell title="Money">
      {query.isPending ? <Loading label="Loading your money…" /> : null}
      {query.isError ? <ErrorBox error={query.error} onRetry={() => query.refetch()} /> : null}
      {query.data ? (
        query.data.length === 0 ? (
          <Empty title="Nothing recorded yet" hint="Lines show up as loads and receipts land." />
        ) : (
          <div className="space-y-6">
            {[...groups.entries()].map(([week, lines]) => {
              const total = lines.reduce((sum, l) => sum + Number(l.amount), 0);
              return (
                <section key={week}>
                  <div className="mb-2 flex items-baseline justify-between">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      {formatWeekLabel(week)}
                    </h2>
                    <span className={`font-bold ${total < 0 ? "text-ez-red" : "text-ez-green"}`}>
                      {money(total)}
                    </span>
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-border bg-card">
                    <table className="w-full text-sm">
                      <tbody>
                        {lines.map((line) => (
                          <tr key={line.id} className="border-b border-border/60 last:border-0">
                            <td className="p-3">
                              <p className="font-medium">{line.category}</p>
                              <p className="text-xs text-muted-foreground">
                                {line.at ? new Date(line.at).toLocaleDateString() : "—"}
                                {line.load?.reference ? ` · ${line.load.reference}` : ""}
                              </p>
                            </td>
                            <td
                              className={`p-3 text-right font-semibold ${
                                Number(line.amount) < 0 ? "text-destructive" : ""
                              }`}
                            >
                              {money(Number(line.amount))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}
          </div>
        )
      ) : null}
    </AppShell>
  );
}
