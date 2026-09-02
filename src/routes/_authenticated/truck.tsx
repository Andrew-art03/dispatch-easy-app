import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useMe } from "@/lib/session";
import { AppShell, ErrorBox, Loading } from "@/components/AppShell";
import type { EquipmentType, Truck } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/truck")({
  head: () => ({
    meta: [
      { title: "Your truck — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content: "Set your fuel, maintenance, tires, overhead and pay so every load gets scored on your real numbers.",
      },
      { property: "og:title", content: "Your truck — EZ Trucking Auto Dispatching" },
      {
        property: "og:description",
        content: "Set your real costs so every load gets scored on your numbers, not averages.",
      },
    ],
  }),
  component: TruckPage,
});

const EQUIPMENT: EquipmentType[] = ["van", "reefer", "flatbed", "stepdeck", "hotshot", "box", "other"];

type Form = {
  unit_number: string;
  equipment: EquipmentType;
  mpg_loaded: string;
  mpg_empty: string;
  fuel_discount_per_gal: string;
  maintenance_reserve_per_mile: string;
  tire_reserve_per_mile: string;
  overhead_per_day: string;
  driver_pay_type: string;
  driver_pay_value: string;
  cpm_target: string;
  max_deadhead_miles: string;
  banned_states: string;
  home_base_city: string;
  home_base_lat: string;
  home_base_lng: string;
};

const EMPTY: Form = {
  unit_number: "",
  equipment: "van",
  mpg_loaded: "6.5",
  mpg_empty: "7.5",
  fuel_discount_per_gal: "0",
  maintenance_reserve_per_mile: "0.12",
  tire_reserve_per_mile: "0.04",
  overhead_per_day: "150",
  driver_pay_type: "none",
  driver_pay_value: "0",
  cpm_target: "",
  max_deadhead_miles: "150",
  banned_states: "",
  home_base_city: "",
  home_base_lat: "",
  home_base_lng: "",
};

const REQUIRED: (keyof Form)[] = [
  "unit_number",
  "equipment",
  "mpg_loaded",
  "mpg_empty",
  "fuel_discount_per_gal",
  "maintenance_reserve_per_mile",
  "tire_reserve_per_mile",
  "overhead_per_day",
  "driver_pay_type",
  "driver_pay_value",
  "cpm_target",
  "max_deadhead_miles",
  "home_base_lat",
  "home_base_lng",
];

function num(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function TruckPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form>(EMPTY);
  const [saved, setSaved] = useState(false);

  const truckQuery = useQuery({
    queryKey: ["truck"],
    queryFn: async (): Promise<Truck | null> => {
      const { data, error } = await supabase
        .from("truck")
        .select("*")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as Truck) ?? null;
    },
  });

  useEffect(() => {
    const t = truckQuery.data;
    if (!t) return;
    setForm({
      unit_number: t.unit_number ?? "",
      equipment: t.equipment ?? "van",
      mpg_loaded: t.mpg_loaded?.toString() ?? "",
      mpg_empty: t.mpg_empty?.toString() ?? "",
      fuel_discount_per_gal: t.fuel_discount_per_gal?.toString() ?? "",
      maintenance_reserve_per_mile: t.maintenance_reserve_per_mile?.toString() ?? "",
      tire_reserve_per_mile: t.tire_reserve_per_mile?.toString() ?? "",
      overhead_per_day: t.overhead_per_day?.toString() ?? "",
      driver_pay_type: t.driver_pay_type ?? "none",
      driver_pay_value: t.driver_pay_value?.toString() ?? "",
      cpm_target: t.cpm_target?.toString() ?? "",
      max_deadhead_miles: t.max_deadhead_miles?.toString() ?? "",
      banned_states: (t.banned_states ?? []).join(", "),
      home_base_city: "",
      home_base_lat: t.home_base_lat?.toString() ?? "",
      home_base_lng: t.home_base_lng?.toString() ?? "",
    });
  }, [truckQuery.data]);

  const filled = REQUIRED.filter((key) => form[key].toString().trim() !== "").length;
  const completeness = Math.round((filled / REQUIRED.length) * 100);

  const save = useMutation({
    mutationFn: async () => {
      const orgId = me.data?.orgId;
      if (!orgId) throw new Error("No company found for your account.");
      const payload = {
        org_id: orgId,
        unit_number: form.unit_number.trim(),
        equipment: form.equipment,
        mpg_loaded: num(form.mpg_loaded),
        mpg_empty: num(form.mpg_empty),
        fuel_discount_per_gal: num(form.fuel_discount_per_gal),
        maintenance_reserve_per_mile: num(form.maintenance_reserve_per_mile),
        tire_reserve_per_mile: num(form.tire_reserve_per_mile),
        overhead_per_day: num(form.overhead_per_day),
        driver_pay_type: form.driver_pay_type,
        driver_pay_value: num(form.driver_pay_value),
        cpm_target: num(form.cpm_target),
        max_deadhead_miles: num(form.max_deadhead_miles),
        banned_states: form.banned_states
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
        home_base_lat: num(form.home_base_lat),
        home_base_lng: num(form.home_base_lng),
      };
      if (truckQuery.data) {
        const { error } = await supabase.from("truck").update(payload).eq("id", truckQuery.data.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("truck").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["truck"] });
    },
  });

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  if (truckQuery.isPending || me.isPending) {
    return (
      <AppShell title="Your truck">
        <Loading />
      </AppShell>
    );
  }

  return (
    <AppShell title="Your truck">
      {truckQuery.isError ? (
        <ErrorBox error={truckQuery.error} onRetry={() => truckQuery.refetch()} />
      ) : null}

      <div className="mb-4 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Profile filled in</span>
          <span className="font-bold text-primary">{completeness}%</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
          <div className="h-full bg-primary transition-all" style={{ width: `${completeness}%` }} />
        </div>
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Group title="The truck">
          <Field label="Unit number">
            <input className="ez-input" value={form.unit_number} onChange={set("unit_number")} required />
          </Field>
          <Field label="Equipment">
            <select className="ez-input" value={form.equipment} onChange={set("equipment")}>
              {EQUIPMENT.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>
        </Group>

        <Group title="Fuel">
          <Field label="MPG loaded">
            <input className="ez-input" inputMode="decimal" value={form.mpg_loaded} onChange={set("mpg_loaded")} />
          </Field>
          <Field label="MPG empty">
            <input className="ez-input" inputMode="decimal" value={form.mpg_empty} onChange={set("mpg_empty")} />
          </Field>
          <Field label="Fuel discount per gallon">
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.fuel_discount_per_gal}
              onChange={set("fuel_discount_per_gal")}
            />
          </Field>
        </Group>

        <Group title="Money set aside">
          <Field label="Maintenance per mile">
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.maintenance_reserve_per_mile}
              onChange={set("maintenance_reserve_per_mile")}
            />
          </Field>
          <Field label="Tires per mile">
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.tire_reserve_per_mile}
              onChange={set("tire_reserve_per_mile")}
            />
          </Field>
          <Field label="Overhead per day">
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.overhead_per_day}
              onChange={set("overhead_per_day")}
            />
          </Field>
        </Group>

        <Group title="Driver pay">
          <Field label="Pay type">
            <select className="ez-input" value={form.driver_pay_type} onChange={set("driver_pay_type")}>
              <option value="none">None (I drive)</option>
              <option value="per_mile">Per mile</option>
              <option value="percent">Percent of gross</option>
              <option value="per_day">Per day</option>
            </select>
          </Field>
          <Field label="Pay amount">
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.driver_pay_value}
              onChange={set("driver_pay_value")}
            />
          </Field>
        </Group>

        <Group title="What you will haul">
          <Field label="Target cost per mile">
            <input className="ez-input" inputMode="decimal" value={form.cpm_target} onChange={set("cpm_target")} />
          </Field>
          <Field label="Max deadhead miles">
            <input
              className="ez-input"
              inputMode="numeric"
              value={form.max_deadhead_miles}
              onChange={set("max_deadhead_miles")}
            />
          </Field>
          <Field label="States you won't run">
            <input
              className="ez-input"
              value={form.banned_states}
              onChange={set("banned_states")}
              placeholder="NY, CA"
            />
          </Field>
        </Group>

        <Group title="Home base">
          <Field label="City">
            <input
              className="ez-input"
              value={form.home_base_city}
              onChange={set("home_base_city")}
              placeholder="Laredo, TX"
            />
          </Field>
          <Field label="Latitude">
            <input className="ez-input" inputMode="decimal" value={form.home_base_lat} onChange={set("home_base_lat")} />
          </Field>
          <Field label="Longitude">
            <input className="ez-input" inputMode="decimal" value={form.home_base_lng} onChange={set("home_base_lng")} />
          </Field>
        </Group>

        {save.isError ? <ErrorBox error={save.error} /> : null}
        {saved ? <p className="text-sm text-primary">Saved.</p> : null}

        <button type="submit" disabled={save.isPending} className="ez-btn-primary w-full">
          {save.isPending ? "Saving…" : "Save truck"}
        </button>
      </form>
    </AppShell>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
