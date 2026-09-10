import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CalendarDays, Compass, Globe2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useMe } from "@/lib/session";
import { ErrorBox, Loading } from "@/components/AppShell";
import type { EquipmentType } from "@/lib/types";

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
];

type TripLength = "1w" | "2w" | "3w" | "custom";
type DirectionMode = "direction" | "anywhere";

type HuntRow = {
  id: string;
  truck_id: string | null;
  origin_city: string | null;
  origin_radius_mi: number | null;
  dest_states: string[] | null;
  equipment: EquipmentType | null;
  min_rpm: number | null;
  home_by: string | null;
  active: boolean | null;
};

type Form = {
  tripLength: TripLength;
  homeBy: string; // yyyy-mm-dd
  homeByManual: boolean;
  mode: DirectionMode;
  destStates: string[];
  minRpm: string;
  originCity: string;
  originRadiusMi: string;
  active: boolean;
};

const EMPTY: Form = {
  tripLength: "1w",
  homeBy: "",
  homeByManual: false,
  mode: "anywhere",
  destStates: [],
  minRpm: "",
  originCity: "",
  originRadiusMi: "150",
  active: true,
};

function num(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addWeeks(weeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  return toDateInput(d);
}

function prettyDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function TripDirection() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form>(EMPTY);
  const [saved, setSaved] = useState(false);

  const huntQuery = useQuery({
    queryKey: ["hunt"],
    queryFn: async (): Promise<HuntRow | null> => {
      const { data, error } = await supabase
        .from("hunt")
        .select("id, truck_id, origin_city, origin_radius_mi, dest_states, equipment, min_rpm, home_by, active")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as HuntRow) ?? null;
    },
  });

  useEffect(() => {
    const h = huntQuery.data;
    if (!h) return;
    const destStates = h.dest_states ?? [];
    setForm({
      tripLength: "custom",
      homeBy: h.home_by ? toDateInput(new Date(h.home_by)) : "",
      homeByManual: true,
      mode: destStates.length > 0 ? "direction" : "anywhere",
      destStates,
      minRpm: h.min_rpm?.toString() ?? "",
      originCity: h.origin_city ?? "",
      originRadiusMi: h.origin_radius_mi?.toString() ?? "150",
      active: h.active ?? true,
    });
  }, [huntQuery.data]);

  const setField = <K extends keyof Form>(key: K, value: Form[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const pickTripLength = (len: TripLength) => {
    setSaved(false);
    setForm((f) => {
      const next = { ...f, tripLength: len };
      if (len !== "custom" && !f.homeByManual) {
        next.homeBy = addWeeks(len === "1w" ? 1 : len === "2w" ? 2 : 3);
      }
      return next;
    });
  };

  const toggleState = (code: string) => {
    setSaved(false);
    setForm((f) => ({
      ...f,
      destStates: f.destStates.includes(code)
        ? f.destStates.filter((s) => s !== code)
        : [...f.destStates, code],
    }));
  };

  const save = useMutation({
    mutationFn: async () => {
      const orgId = me.data?.orgId;
      if (!orgId) throw new Error("No company found for your account.");
      const payload: Record<string, unknown> = {
        org_id: orgId,
        origin_city: form.originCity.trim() || null,
        origin_radius_mi: num(form.originRadiusMi),
        dest_states: form.mode === "direction" ? form.destStates : null,
        min_rpm: num(form.minRpm),
        home_by: form.homeBy ? new Date(`${form.homeBy}T17:00:00`).toISOString() : null,
        active: form.active,
      };
      if (huntQuery.data) {
        const { error } = await supabase.from("hunt").update(payload).eq("id", huntQuery.data.id);
        if (error) throw error;
      } else {
        const { data: truck } = await supabase
          .from("truck")
          .select("id, equipment")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (truck) {
          payload["truck_id"] = truck["id"];
          payload["equipment"] = truck["equipment"];
        }
        const { error } = await supabase.from("hunt").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["hunt"] });
    },
  });

  if (huntQuery.isPending || me.isPending) return <Loading />;

  const suggested = form.homeBy ? prettyDate(form.homeBy) : null;

  return (
    <section className="space-y-4 rounded-md border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="ez-section-title text-muted-foreground">
          Trip &amp; direction
        </h2>
        <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
          <span className={form.active ? "text-primary" : "text-muted-foreground"}>
            {form.active ? "Hunting is ON" : "Hunting is OFF"}
          </span>
          <input
            type="checkbox"
            className="size-6 accent-[var(--color-ez-amber)]"
            checked={form.active}
            onChange={(e) => setField("active", e.target.checked)}
          />
        </label>
      </div>

      {huntQuery.isError ? (
        <ErrorBox error={huntQuery.error} onRetry={() => huntQuery.refetch()} />
      ) : null}

      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div>
          <p className="mb-2 text-sm font-medium">How long is this trip?</p>
          <div className="grid grid-cols-4 gap-2">
            {(
              [
                ["1w", "1 week"],
                ["2w", "2 weeks"],
                ["3w", "3 weeks"],
                ["custom", "Custom"],
              ] as [TripLength, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => pickTripLength(id)}
                aria-pressed={form.tripLength === id}
                className={`min-h-12 rounded-md border text-sm font-semibold ${
                  form.tripLength === id
                    ? "border-ez-amber bg-ez-amber/10 text-ez-amber"
                    : "border-border bg-surface-2 text-muted-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {suggested ? (
            <div className="mt-4 flex items-center gap-2 rounded-md border border-ez-amber/30 bg-transparent px-4 py-3">
              <CalendarDays className="size-5 shrink-0 text-ez-amber" />
              <span className="text-sm font-semibold text-ez-amber">
                Start heading home by {suggested}
              </span>
            </div>
          ) : null}

          <label className="mt-3 block">
            <span className="mb-1 block text-sm text-muted-foreground">
              Change that date if you want
            </span>
            <input
              type="date"
              className="ez-input"
              value={form.homeBy}
              onChange={(e) => {
                setSaved(false);
                setForm((f) => ({ ...f, homeBy: e.target.value, homeByManual: true }));
              }}
            />
          </label>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Which way do you want to run?</p>
          <div className="grid grid-cols-1 gap-2">
            <button
              type="button"
              onClick={() => setField("mode", "direction")}
              aria-pressed={form.mode === "direction"}
              className={`flex min-h-14 items-center gap-3 rounded-md border px-4 text-left text-sm font-semibold ${
                form.mode === "direction"
                  ? "border-ez-amber bg-ez-amber/10 text-ez-amber"
                  : "border-border bg-surface-2 text-muted-foreground"
              }`}
            >
              <Compass className="size-5 shrink-0" />
              Head this direction
            </button>
            <button
              type="button"
              onClick={() => setField("mode", "anywhere")}
              aria-pressed={form.mode === "anywhere"}
              className={`flex min-h-14 items-center gap-3 rounded-md border px-4 text-left text-sm font-semibold ${
                form.mode === "anywhere"
                  ? "border-ez-amber bg-ez-amber/10 text-ez-amber"
                  : "border-border bg-surface-2 text-muted-foreground"
              }`}
            >
              <Globe2 className="size-5 shrink-0" />
              Let EZ find the best load anywhere
            </button>
          </div>

          {form.mode === "direction" ? (
            <div className="mt-3 grid grid-cols-5 gap-2">
              {US_STATES.map((code) => {
                const on = form.destStates.includes(code);
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => toggleState(code)}
                    aria-pressed={on}
                    className={`ez-label min-h-10 rounded border ${
                      on
                        ? "border-ez-amber bg-ez-amber/15 text-ez-amber"
                        : "border-border bg-surface-2 text-muted-foreground"
                    }`}
                  >
                    {code}
                  </button>
                );
              })}
            </div>
          ) : null}

          <p className="mt-3 text-xs text-muted-foreground">
            Once your home-by date gets close, EZ will start favoring loads that point you home,
            no matter what you pick here.
          </p>
        </div>

        <label className="block">
          <span className="mb-1 block text-sm text-muted-foreground">
            Minimum rate you'll accept ($/mile, optional)
          </span>
          <input
            className="ez-input"
            inputMode="decimal"
            placeholder="2.50"
            value={form.minRpm}
            onChange={(e) => setField("minRpm", e.target.value)}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm text-muted-foreground">Starting city</span>
            <input
              className="ez-input"
              placeholder="Laredo, TX"
              value={form.originCity}
              onChange={(e) => setField("originCity", e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-muted-foreground">Radius (miles)</span>
            <input
              className="ez-input"
              inputMode="numeric"
              value={form.originRadiusMi}
              onChange={(e) => setField("originRadiusMi", e.target.value)}
            />
          </label>
        </div>

        {save.isError ? <ErrorBox error={save.error} /> : null}
        {saved ? <p className="text-sm text-primary">Saved.</p> : null}

        <button type="submit" disabled={save.isPending} className="ez-btn-amber mt-4 w-full">
          {save.isPending ? "Saving…" : "Save trip"}
        </button>
      </form>
    </section>
  );
}
