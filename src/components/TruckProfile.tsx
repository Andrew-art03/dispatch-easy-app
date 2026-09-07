import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useMe } from "@/lib/session";
import { ErrorBox, Loading } from "@/components/AppShell";
import type { EquipmentType, Truck } from "@/lib/types";

const EQUIPMENT: EquipmentType[] = [
  "van",
  "reefer",
  "flatbed",
  "stepdeck",
  "hotshot",
  "box",
  "other",
];

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
  height_ft: string;
  length_ft: string;
  weight_lb: string;
  hazmat: boolean;
  hos_hours_left: string;
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
  height_ft: "13.6",
  length_ft: "53",
  weight_lb: "",
  hazmat: false,
  hos_hours_left: "",
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
  "height_ft",
  "length_ft",
  "weight_lb",
  "hos_hours_left",
  "home_base_lat",
  "home_base_lng",
];

function num(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function TruckProfile() {
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

  const driverQuery = useQuery({
    queryKey: ["driver"],
    queryFn: async (): Promise<{ id: string; hos_hours_left: number | null } | null> => {
      const { data, error } = await supabase
        .from("driver")
        .select("id, hos_hours_left")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as { id: string; hos_hours_left: number | null }) ?? null;
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
      height_ft: t.height_ft?.toString() ?? "",
      length_ft: t.length_ft?.toString() ?? "",
      weight_lb: t.weight_lb?.toString() ?? "",
      hazmat: Boolean(t.hazmat),
      hos_hours_left: driverQuery.data?.hos_hours_left?.toString() ?? "",
      home_base_city: "",
      home_base_lat: t.home_base_lat?.toString() ?? "",
      home_base_lng: t.home_base_lng?.toString() ?? "",
    });
  }, [truckQuery.data, driverQuery.data]);

  const filled = REQUIRED.filter((key) => String(form[key]).trim() !== "").length;
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
        height_ft: num(form.height_ft),
        length_ft: num(form.length_ft),
        weight_lb: num(form.weight_lb),
        hazmat: form.hazmat,
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

      const hours = num(form.hos_hours_left);
      if (driverQuery.data) {
        const { error } = await supabase
          .from("driver")
          .update({ hos_hours_left: hours })
          .eq("id", driverQuery.data.id);
        if (error) throw error;
      } else if (hours !== null) {
        const { error } = await supabase.from("driver").insert({
          org_id: orgId,
          name: me.data?.fullName ?? "Me",
          hos_hours_left: hours,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["truck"] });
      queryClient.invalidateQueries({ queryKey: ["driver"] });
    },
  });

  const setBool = (key: keyof Form) => (value: boolean) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  if (truckQuery.isPending || driverQuery.isPending || me.isPending) {
    return <Loading />;
  }

  return (
    <>
      {truckQuery.isError ? (
        <ErrorBox error={truckQuery.error} onRetry={() => truckQuery.refetch()} />
      ) : null}

      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Profile filled in</span>
          <span className="font-bold text-primary">{completeness}%</span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary">
          <div className="h-full bg-primary transition-all" style={{ width: `${completeness}%` }} />
        </div>
      </div>

      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Group title="The truck">
          <Field label="Unit number">
            <input
              className="ez-input"
              value={form.unit_number}
              onChange={set("unit_number")}
              required
            />
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

        <Group title="Size and load limits">
          <Field
            label="Height (feet)"
            hint="Tallest point of the rig — keeps low bridges off your route."
          >
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.height_ft}
              onChange={set("height_ft")}
            />
          </Field>
          <Field label="Trailer length (feet)">
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.length_ft}
              onChange={set("length_ft")}
            />
          </Field>
          <Field
            label="Max weight you can haul (lbs)"
            hint="Most you can legally put on the trailer."
          >
            <input
              className="ez-input"
              inputMode="numeric"
              value={form.weight_lb}
              onChange={set("weight_lb")}
            />
          </Field>
          <label className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 px-4">
            <span className="text-sm font-medium">Hazmat endorsed</span>
            <input
              type="checkbox"
              className="size-6 accent-[var(--color-ez-amber)]"
              checked={form.hazmat}
              onChange={(e) => setBool("hazmat")(e.target.checked)}
            />
          </label>
        </Group>

        <Group title="Hours left">
          <Field
            label="Hours you have left to drive"
            hint="Your numbers, not your log. EZ uses it to see if a load fits today."
          >
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.hos_hours_left}
              onChange={set("hos_hours_left")}
              placeholder="8"
            />
          </Field>
        </Group>

        <Group title="Fuel">
          <Field label="MPG loaded">
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.mpg_loaded}
              onChange={set("mpg_loaded")}
            />
          </Field>
          <Field label="MPG empty">
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.mpg_empty}
              onChange={set("mpg_empty")}
            />
          </Field>
          <Field label="Fuel discount per gallon" hint="Your card/network discount off pump price.">
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.fuel_discount_per_gal}
              onChange={set("fuel_discount_per_gal")}
            />
          </Field>
        </Group>

        <Group title="Money set aside">
          <Field
            label="Maintenance per mile"
            hint="Money set aside per mile so repairs don't surprise you."
          >
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.maintenance_reserve_per_mile}
              onChange={set("maintenance_reserve_per_mile")}
            />
          </Field>
          <Field
            label="Tires per mile"
            hint="Money set aside per mile so repairs don't surprise you."
          >
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.tire_reserve_per_mile}
              onChange={set("tire_reserve_per_mile")}
            />
          </Field>
          <Field
            label="Overhead per day"
            hint="Insurance, permits, phone — fixed costs whether you're rolling or not."
          >
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
            <select
              className="ez-input"
              value={form.driver_pay_type}
              onChange={set("driver_pay_type")}
            >
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
          <Field
            label="Target cost per mile"
            hint="Your break-even. EZ won't recommend loads below this without flagging it."
          >
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.cpm_target}
              onChange={set("cpm_target")}
            />
          </Field>
          <Field
            label="Max deadhead miles"
            hint="How far empty you're willing to drive to reach a load."
          >
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
          <Field
            label="City"
            hint="Used to fill in your coordinates below — not stored on its own."
          >
            <input
              className="ez-input"
              value={form.home_base_city}
              onChange={set("home_base_city")}
              placeholder="Laredo, TX"
            />
          </Field>

          <Field label="Latitude">
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.home_base_lat}
              onChange={set("home_base_lat")}
            />
          </Field>
          <Field label="Longitude">
            <input
              className="ez-input"
              inputMode="decimal"
              value={form.home_base_lng}
              onChange={set("home_base_lng")}
            />
          </Field>
        </Group>

        {save.isError ? <ErrorBox error={save.error} /> : null}
        {saved ? <p className="text-sm text-primary">Saved.</p> : null}

        <button type="submit" disabled={save.isPending} className="ez-btn-amber w-full">
          {save.isPending ? "Saving…" : "Save truck"}
        </button>
      </form>
    </>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-muted-foreground">{label}</span>
      {children}
      {hint ? (
        <span className="mt-1.5 block text-xs leading-snug text-muted-foreground/80">{hint}</span>
      ) : null}
    </label>
  );
}
