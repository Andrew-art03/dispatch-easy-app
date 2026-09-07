import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { authedFetch } from "@/lib/session";
import { AppShell, ErrorBox, Loading } from "@/components/AppShell";
import type { Deal, LoadState, LoadWithRelations } from "@/lib/types";
import { EZStatusLine, useEZVoice } from "@/components/EZVoice";
import { TrustCue } from "@/components/TrustCue";
import {
  latestScore,
  money,
  prettyLabel,
  prettyValue,
  rpm,
  stopLabel,
  VERDICT_LABEL,
} from "@/lib/load-utils";

export const Route = createFileRoute("/_authenticated/loads/$id")({
  head: () => ({
    meta: [
      { title: "Load details — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content:
          "True net, all-in rate per mile, recommended bid and the reasons behind the call on this load.",
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
  const voice = useEZVoice();

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

  // Read-only: used by the "What's left" checklist. Never writes.
  const docsQuery = useQuery({
    queryKey: ["load-docs", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document")
        .select("id, type")
        .eq("load_id", id);
      if (error) throw error;
      return (data ?? []) as { id: string; type: string }[];
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

  // Read-only checklist derived from load.state + existing document rows.
  const STATE_ORDER: LoadState[] = [
    "candidate_found",
    "qualified",
    "pursue_approved",
    "negotiating",
    "terms_proposed",
    "rate_con_received",
    "booked",
    "in_transit",
    "delivered",
    "billing_ready",
    "paid_reconciled",
    "learned",
  ];
  const stateAt = (s: LoadState) => STATE_ORDER.indexOf(s);
  const reached = (s: LoadState) =>
    load.state !== "rejected" && stateAt(load.state) >= stateAt(s) && stateAt(load.state) >= 0;
  const hasPod = (docsQuery.data ?? []).some((d) => d.type === "pod");
  const checklist: { label: string; done: boolean; easy?: boolean }[] = [
    { label: "Found and scored this load", done: Boolean(score) },
    { label: "You approved pursuing it", done: reached("pursue_approved") },
    { label: "Get rate confirmation", done: reached("rate_con_received") },
    { label: "Tap Confirm load", done: reached("booked"), easy: true },
    { label: "Upload delivery docs", done: hasPod },
  ];

  const keep = money(score?.true_net ?? null);
  const verdictWord = score ? VERDICT_LABEL[score.verdict] : "No call yet";

  const openLoadVoice = () =>
    voice.openWith({
      transcript: "Book the Amarillo load",
      heard: [
        { label: "Load", value: load.reference ?? "this load", sure: true },
        { label: "Action", value: "Confirm load", sure: true },
        { label: "Pay terms", value: deal?.payment_terms ?? "not read yet", sure: false },
      ],
      keepAmount: keep,
      rpmLabel: rpm(score?.all_in_rpm ?? null),
      verdictWord,
      confirmDisabled: !canConfirm || callEndpoint.isPending,
      onConfirm: () => {
        callEndpoint.mutate("confirm");
        voice.close();
      },
    });
  const gross = Number(load.gross_rate ?? 0);
  const net = Number(score?.true_net ?? 0);
  const tripCost = score?.true_net != null && load.gross_rate != null ? gross - net : null;
  const minsAgo = score?.created_at
    ? Math.max(1, Math.round((Date.now() - new Date(score.created_at).getTime()) / 60000))
    : null;
  const floor = score?.floor_rate ?? deal?.floor_rate ?? null;

  const chips: { title: string; sentence: string; watch: boolean }[] = [
    {
      title: "Fit",
      sentence: load.equipment
        ? `Runs on your ${load.equipment} with ${load.deadhead_miles ?? 0} miles of empty.`
        : "Equipment not listed on this load yet.",
      watch: (load.deadhead_miles ?? 0) > 150 || !load.equipment,
    },
    {
      title: "Profit",
      sentence:
        score?.true_net != null
          ? `You keep about ${keep} after estimated trip costs.`
          : "No numbers scored yet on this load.",
      watch: score?.verdict !== "take",
    },
    {
      title: "Market",
      sentence: `Your floor ${money(floor)} · Market not verified · your approval required`,
      watch: true,
    },
  ];

  return (
    <AppShell title={load.reference ?? "Load"}>
      <div className="space-y-5">
        <EZStatusLine
          text={`EZ found your best move · high confidence · ${minsAgo ?? "—"} min ago`}
        />

        <section className="rounded-2xl border border-border bg-card p-5">
          {load.reference ? <p className="ez-ref text-muted-foreground">{load.reference}</p> : null}
          <p className="mt-1 text-sm text-muted-foreground">
            You keep about
            <TrustCue label="Estimated net" />
          </p>
          <p className="ez-num text-6xl text-foreground">{keep}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            after estimated trip costs ·{" "}
            <span className="font-semibold text-foreground">{verdictWord}</span>
          </p>

          <dl className="mt-5 grid grid-cols-3 gap-3 text-center">
            <Stat label="All-in / mi" value={rpm(score?.all_in_rpm ?? null)} />
            <Stat label="Gross" value={money(load.gross_rate)} />
            <Stat
              label="Miles"
              value={load.loaded_miles ? String(load.loaded_miles) : "—"}
              note={load.deadhead_miles ? `+${load.deadhead_miles} empty` : undefined}
            />
          </dl>
        </section>

        <section className="space-y-2">
          {chips.map((chip) => (
            <div key={chip.title} className={`ez-chip ${chip.watch ? "ez-chip-watch" : ""}`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {chip.title}
              </p>
              <p className="text-sm">{chip.sentence}</p>
            </div>
          ))}
        </section>

        <section className="rounded-2xl border border-border bg-card p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            EZ's call
          </p>
          <p className="mt-1 text-base">
            {score?.reasons?.[0] ?? "EZ has not scored this load yet."}
          </p>
          <p className="mt-2 text-sm">
            <span className="font-semibold text-ez-amber">Watch it:</span>{" "}
            {load.state === "rate_con_received"
              ? "Rate con is in — read the pay terms before you confirm."
              : "No rate con yet, so the terms can still change."}
          </p>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Stops
          </h2>
          <ol className="mt-2 space-y-3">
            {stops.map((stop) => (
              <li key={stop.id} className="flex gap-3">
                <span className="mt-1 size-2 shrink-0 rounded-full bg-ez-green" />
                <div className="min-w-0">
                  <p className="text-xs uppercase text-muted-foreground">{stop.type}</p>
                  <p className="font-medium">{stopLabel(stop)}</p>
                  <p className="text-sm text-muted-foreground">{stop.address}</p>
                  {stop.window_start ? (
                    <p className="text-sm text-muted-foreground">
                      {new Date(stop.window_start).toLocaleString()}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
            {stops.length === 0 ? (
              <p className="text-sm text-muted-foreground">No stops yet.</p>
            ) : null}
          </ol>
        </section>

        <section className="rounded-2xl border border-border bg-card">
          <button
            onClick={() => setShowMath((v) => !v)}
            className="flex min-h-12 w-full items-center justify-between p-5 text-left font-medium"
          >
            How we calculated this
            <span className="text-muted-foreground">{showMath ? "Hide" : "Show"}</span>
          </button>
          {showMath ? (
            <dl className="border-t border-border p-5 text-sm">
              <Line label="Gross pay" value={money(load.gross_rate)} />
              <Line label="Trip cost" value={tripCost != null ? `− ${money(tripCost)}` : "—"} />
              <Line label="You keep" value={keep} />
              <Line
                label="Miles"
                value={`${load.loaded_miles ?? "—"} loaded · ${load.deadhead_miles ?? 0} empty`}
              />
              {Object.entries(inputs).map(([key, value]) => (
                <Line key={key} label={prettyLabel(key)} value={prettyValue(value)} />
              ))}
            </dl>
          ) : null}
        </section>

        <Link to="/docs/$loadId" params={{ loadId: load.id }} className="ez-btn-secondary">
          Paperwork for this load
        </Link>

        {actionError ? <ErrorBox error={new Error(actionError)} /> : null}
        {actionNote ? (
          <p className="rounded-xl border border-border bg-card p-3 text-sm text-ez-green">
            {actionNote}
          </p>
        ) : null}

        <p className="text-center text-xs text-muted-foreground">
          Your approval required — EZ never books a load on its own.
        </p>

        <button
          onClick={() => callEndpoint.mutate("pursue")}
          disabled={callEndpoint.isPending}
          className="ez-btn-amber disabled:opacity-40"
        >
          {callEndpoint.isPending ? "Working…" : "Pursue this load"}
        </button>

        <div className="grid grid-cols-2 gap-3">
          <button onClick={openLoadVoice} className="ez-btn-secondary text-ez-amber">
            Ask EZ why
          </button>
          <button
            onClick={() => callEndpoint.mutate("skip")}
            disabled={callEndpoint.isPending}
            className="ez-btn-secondary text-muted-foreground"
          >
            Skip
          </button>
        </div>

        <p className="pt-1 text-center text-sm text-muted-foreground">
          Show alternatives · Ask {money(score?.recommended_bid ?? null)} (soon)
          <TrustCue label="Draft only" />
        </p>

        {canConfirm ? (
          <button
            onClick={() => callEndpoint.mutate("confirm")}
            disabled={callEndpoint.isPending}
            className="ez-btn-secondary"
          >
            Confirm load
          </button>
        ) : null}

        {!canConfirm ? (
          <p className="text-center text-sm text-muted-foreground">
            You can confirm once the rate con is in.
          </p>
        ) : null}
      </div>
    </AppShell>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/60 py-2 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="ez-num mt-1 text-2xl">{value}</dd>
      {note ? <dd className="text-xs text-ez-amber">{note}</dd> : null}
    </div>
  );
}
