import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { authedFetch, useMe } from "@/lib/session";
import { AppShell, ErrorBox } from "@/components/AppShell";
import type { EquipmentType } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/hunt")({
  head: () => ({
    meta: [
      { title: "Paste a load — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content: "Paste the load text or snap the posting, check the fields we pulled out, and add it to your board.",
      },
      { property: "og:title", content: "Paste a load — EZ Trucking Auto Dispatching" },
      {
        property: "og:description",
        content: "Paste the load or snap the posting and add it to your board in seconds.",
      },
    ],
  }),
  component: HuntPage,
});

type Parsed = {
  reference: string;
  gross_rate: string;
  equipment: EquipmentType;
  loaded_miles: string;
  pickup_at: string;
  deliver_by: string;
  origin_address: string;
  origin_city: string;
  origin_state: string;
  dest_address: string;
  dest_city: string;
  dest_state: string;
};

const BLANK: Parsed = {
  reference: "",
  gross_rate: "",
  equipment: "van",
  loaded_miles: "",
  pickup_at: "",
  deliver_by: "",
  origin_address: "",
  origin_city: "",
  origin_state: "",
  dest_address: "",
  dest_city: "",
  dest_state: "",
};

function num(v: string) {
  if (!v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function HuntPage() {
  const me = useMe();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);

  const submit = useMutation({
    mutationFn: async () => {
      const orgId = me.data?.orgId;
      if (!orgId) throw new Error("No company found for your account.");

      let storagePath: string | null = null;
      if (file) {
        const path = `${orgId}/inbox/${Date.now()}-${file.name.replace(/[^\w.-]/g, "_")}`;
        const { error } = await supabase.storage.from("docs").upload(path, file);
        if (error) throw error;
        storagePath = path;
      }

      const res = await authedFetch("/api/loads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: file ? "screenshot" : "paste",
          text,
          storage_path: storagePath,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { fields?: Partial<Parsed>; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not read that load.");
      return { ...BLANK, ...(body.fields ?? {}) } as Parsed;
    },
    onSuccess: (fields) => setParsed(fields),
  });

  const saveLoad = useMutation({
    mutationFn: async () => {
      const orgId = me.data?.orgId;
      if (!orgId || !parsed) throw new Error("Nothing to save.");
      const { data: load, error } = await supabase
        .from("load")
        .insert({
          org_id: orgId,
          source: file ? "screenshot" : "paste",
          reference: parsed.reference || null,
          equipment: parsed.equipment,
          gross_rate: num(parsed.gross_rate),
          loaded_miles: num(parsed.loaded_miles),
          pickup_at: parsed.pickup_at ? new Date(parsed.pickup_at).toISOString() : null,
          deliver_by: parsed.deliver_by ? new Date(parsed.deliver_by).toISOString() : null,
          raw_payload: { text },
        })
        .select("id")
        .single();
      if (error) throw error;

      const stops = [
        {
          org_id: orgId,
          load_id: load["id"],
          seq: 1,
          type: "pickup",
          address: parsed.origin_address || parsed.origin_city || "Unknown",
          city: parsed.origin_city || null,
          state: parsed.origin_state || null,
        },
        {
          org_id: orgId,
          load_id: load["id"],
          seq: 2,
          type: "delivery",
          address: parsed.dest_address || parsed.dest_city || "Unknown",
          city: parsed.dest_city || null,
          state: parsed.dest_state || null,
        },
      ];
      const { error: stopError } = await supabase.from("stop").insert(stops);
      if (stopError) throw stopError;
      return load["id"] as string;
    },
    onSuccess: (id) => navigate({ to: "/loads/$id", params: { id } }),
  });

  const set = (key: keyof Parsed) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setParsed((p) => (p ? { ...p, [key]: e.target.value } : p));

  return (
    <AppShell title="Paste the load">
      {!parsed ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit.mutate();
          }}
        >
          <textarea
            className="ez-input min-h-48"
            placeholder="Paste the load here — rate, pickup, delivery, dates, miles."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <label className="block rounded-2xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            {file ? file.name : "Or add a photo of the posting"}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {submit.isError ? <ErrorBox error={submit.error} /> : null}
          <button
            type="submit"
            disabled={submit.isPending || (!text.trim() && !file)}
            className="ez-btn-primary w-full disabled:opacity-40"
          >
            {submit.isPending ? "Reading…" : "Read this load"}
          </button>
        </form>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            saveLoad.mutate();
          }}
        >
          <p className="text-sm text-muted-foreground">Check these before you save.</p>
          <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
            <F label="Reference"><input className="ez-input" value={parsed.reference} onChange={set("reference")} /></F>
            <F label="Rate"><input className="ez-input" inputMode="decimal" value={parsed.gross_rate} onChange={set("gross_rate")} /></F>
            <F label="Equipment">
              <select className="ez-input" value={parsed.equipment} onChange={set("equipment")}>
                {["van", "reefer", "flatbed", "stepdeck", "hotshot", "box", "other"].map((e) => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
            </F>
            <F label="Loaded miles"><input className="ez-input" inputMode="numeric" value={parsed.loaded_miles} onChange={set("loaded_miles")} /></F>
            <F label="Pickup"><input className="ez-input" type="datetime-local" value={parsed.pickup_at} onChange={set("pickup_at")} /></F>
            <F label="Deliver by"><input className="ez-input" type="datetime-local" value={parsed.deliver_by} onChange={set("deliver_by")} /></F>
          </section>

          <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Pickup</h2>
            <F label="Address"><input className="ez-input" value={parsed.origin_address} onChange={set("origin_address")} /></F>
            <div className="grid grid-cols-2 gap-3">
              <F label="City"><input className="ez-input" value={parsed.origin_city} onChange={set("origin_city")} /></F>
              <F label="State"><input className="ez-input" value={parsed.origin_state} onChange={set("origin_state")} /></F>
            </div>
          </section>

          <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Delivery</h2>
            <F label="Address"><input className="ez-input" value={parsed.dest_address} onChange={set("dest_address")} /></F>
            <div className="grid grid-cols-2 gap-3">
              <F label="City"><input className="ez-input" value={parsed.dest_city} onChange={set("dest_city")} /></F>
              <F label="State"><input className="ez-input" value={parsed.dest_state} onChange={set("dest_state")} /></F>
            </div>
          </section>

          {saveLoad.isError ? <ErrorBox error={saveLoad.error} /> : null}
          <button type="submit" disabled={saveLoad.isPending} className="ez-btn-primary w-full">
            {saveLoad.isPending ? "Saving…" : "Looks right"}
          </button>
          <button
            type="button"
            onClick={() => setParsed(null)}
            className="w-full rounded-xl border border-border py-3 text-sm text-muted-foreground"
          >
            Start over
          </button>
        </form>
      )}
    </AppShell>
  );
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
