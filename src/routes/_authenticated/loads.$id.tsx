import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { authedFetch } from "@/lib/session";
import { AppShell, ErrorBox, Loading } from "@/components/AppShell";
import type { Deal, LoadWithRelations } from "@/lib/types";
import {
  latestScore,
  money,
  prettyLabel,
  prettyValue,
  rpm,
  stopLabel,
  VerdictBadge,
} from "@/lib/load-utils";

export const Route = createFileRoute("/_authenticated/loads/$id")({
  head: () => ({
    meta: [
      { title: "Load details — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content: "True net, all-in rate per mile, recommended bid and the reasons behind the call on this load.",
      },
      { property: "og:title", content: "Load details — EZ Trucking Auto Dispatching" },
      {
        property: "og:description",
        content: "True net, all-in RPM, recommended bid and the reasons behind the call.",
      },
    ],
  }),
  component: LoadCard,
});

function LoadCard() {
  const { id } = useParams({ from: "/_authenticated/loads/$id" });
  const queryClient = useQueryClient();
  const [showMath, setShowMath] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["load", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("load")
        .select("*, stop(*), score(*), deal(*)")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data as unknown as LoadWithRelations;
    },
  });

  const callEndpoint = useMutation({
    mutationFn: async (action: "pursue" | "skip" | "confirm") => {
      const res = await authedFetch(`/api/loads/${id}/${action}`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? "That didn't work.");
      return body.message ?? "Done.";
    },
    onSuccess: (message) => {
      setActionError(null);
      setActionNote(message);
      queryClient.invalidateQueries({ queryKey: ["load", id] });
      queryClient.invalidateQueries({ queryKey: ["board"] });
    },
    onError: (error) => {
      setActionNote(null);
      setActionError(error instanceof Error ? error.message : "That didn't work.");
    },
  });

  if (query.isPending) {
    return (
      <AppShell title="Load">
        <Loading />
      </AppShell>
    );
  }
  if (query.isError || !query.data) {
    return (
      <AppShell title="Load">
        <ErrorBox error={query.error} onRetry={() => query.refetch()} />
      </AppShell>
    );
  }

  const load = query.data;
  const score = latestScore(load.score);
  const deal: Deal | null = load.deal?.[0] ?? null;
  const stops = [...(load.stop ?? [])].sort((a, b) => a.seq - b.seq);
  const inputs = (score?.inputs ?? {}) as Record<string, unknown>;
  const canConfirm = load.state === "rate_con_received";

  return (
    <AppShell title={load.reference ?? "Load"}>
      <div className="space-y-4">
        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-muted-foreground">{load.state.replace(/_/g, " ")}</p>
              <p className="mt-1 text-3xl font-bold">{money(score?.true_net ?? null)}</p>
              <p className="text-sm text-muted-foreground">true net after all costs</p>
            </div>
            {score ? <VerdictBadge verdict={score.verdict} big /> : null}
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <Stat label="All-in per mile" value={rpm(score?.all_in_rpm ?? null)} />
            <Stat label="Net per day" value={money(score?.net_per_day ?? null)} />
            <Stat label="Recommended bid" value={money(score?.recommended_bid ?? null)} />
            <Stat
              label="Walk-away floor"
              value={money(score?.floor_rate ?? deal?.floor_rate ?? null)}
            />
            <Stat label="Gross rate" value={money(load.gross_rate)} />
            <Stat label="Loaded miles" value={load.loaded_miles ? String(load.loaded_miles) : "—"} />
          </dl>
        </section>

        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Stops
          </h2>
          <ol className="mt-2 space-y-3">
            {stops.map((stop) => (
              <li key={stop.id} className="flex gap-3">
                <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
                <div className="min-w-0">
                  <p className="text-xs uppercase text-muted-foreground">{stop.type}</p>
                  <p className="font-medium">{stopLabel(stop)}</p>
                  <p className="truncate text-sm text-muted-foreground">{stop.address}</p>
                  {stop.window_start ? (
                    <p className="text-sm text-muted-foreground">
                      {new Date(stop.window_start).toLocaleString()}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
            {stops.length === 0 ? <p className="text-sm text-muted-foreground">No stops yet.</p> : null}
          </ol>
        </section>

        {score?.reasons && score.reasons.length > 0 ? (
          <section className="rounded-2xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Why
            </h2>
            <ul className="mt-2 space-y-2 text-sm">
              {score.reasons.map((reason, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-primary">•</span>
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="rounded-2xl border border-border bg-card">
          <button
            onClick={() => setShowMath((v) => !v)}
            className="flex w-full items-center justify-between p-4 text-left font-medium"
          >
            How we calculated this
            <span className="text-muted-foreground">{showMath ? "Hide" : "Show"}</span>
          </button>
          {showMath ? (
            <dl className="border-t border-border p-4 text-sm">
              {Object.entries(inputs).length === 0 ? (
                <p className="text-muted-foreground">No inputs recorded for this load.</p>
              ) : (
                Object.entries(inputs).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-4 border-b border-border/60 py-2 last:border-0">
                    <dt className="text-muted-foreground">{prettyLabel(key)}</dt>
                    <dd className="text-right font-medium">{prettyValue(value)}</dd>
                  </div>
                ))
              )}
            </dl>
          ) : null}
        </section>

        <Link
          to="/docs/$loadId"
          params={{ loadId: load.id }}
          className="block rounded-2xl border border-border bg-card p-4 text-center font-medium"
        >
          Paperwork for this load
        </Link>

        {actionError ? <ErrorBox error={new Error(actionError)} /> : null}
        {actionNote ? (
          <p className="rounded-xl border border-border bg-card p-3 text-sm text-primary">
            {actionNote}
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => callEndpoint.mutate("pursue")}
            disabled={callEndpoint.isPending}
            className="rounded-xl border border-border py-4 font-semibold"
          >
            Pursue
          </button>
          <button
            onClick={() => callEndpoint.mutate("skip")}
            disabled={callEndpoint.isPending}
            className="rounded-xl border border-border py-4 font-semibold text-muted-foreground"
          >
            Skip
          </button>
        </div>

        <button
          onClick={() => callEndpoint.mutate("confirm")}
          disabled={!canConfirm || callEndpoint.isPending}
          className="ez-btn-primary w-full disabled:opacity-40"
        >
          {callEndpoint.isPending ? "Working…" : "Confirm load"}
        </button>
        {!canConfirm ? (
          <p className="text-center text-sm text-muted-foreground">
            You can confirm once the rate con is in.
          </p>
        ) : null}
      </div>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-secondary p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold">{value}</dd>
    </div>
  );
}
