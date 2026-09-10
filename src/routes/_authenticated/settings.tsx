import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { AppShell, ErrorBox } from "@/components/AppShell";
import type { EquipmentType } from "@/lib/types";
import { TruckProfile } from "@/components/TruckProfile";
import { TRUCK_COLORS, useTruckBody, useTruckColor } from "@/components/GoalProgress";
import { TruckImage } from "@/components/TruckImage";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content: "Set your truck's real numbers and pick how it looks in the app.",
      },
      { property: "og:title", content: "Settings — EZ Trucking Auto Dispatching" },
      {
        property: "og:description",
        content: "Set your truck's real numbers and pick how it looks in the app.",
      },
    ],
  }),
  component: SettingsPage,
});

// Picture picker. Each tile also maps to the closest frozen equipment enum value.
const BODY_TYPES: {
  id: string;
  label: string;
  // Only the trailer tiles map to a frozen equipment value. Bobtail / 18-Wheeler /
  // Van are pictures only — the truck profile form owns equipment for those.
  equipment?: EquipmentType;
}[] = [
  { id: "bobtail", label: "Bobtail" },
  { id: "semi", label: "18-Wheeler" },
  { id: "van", label: "Van" },
  { id: "flatbedSemi", label: "Flatbed 18-Wheeler" },
  { id: "flatbed", label: "Flatbed Truck" },
  { id: "lowboy", label: "Lowboy", equipment: "stepdeck" },
  {
    id: "gooseneck",
    label: "Gooseneck Trailer",
    equipment: "hotshot",
  },
];

function SettingsPage() {
  const [bodyType, setBodyType] = useTruckBody();
  const [truckColor, setTruckColor] = useTruckColor();
  const queryClient = useQueryClient();

  const truckQuery = useQuery({
    queryKey: ["truck"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("truck")
        .select("*")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as { id: string; equipment: EquipmentType } | null) ?? null;
    },
  });

  const saveEquipment = useMutation({
    mutationFn: async (equipment: EquipmentType) => {
      const truck = truckQuery.data;
      if (!truck) return; // no truck row yet — the profile form below creates it
      const { error } = await supabase.from("truck").update({ equipment }).eq("id", truck.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["truck"] }),
  });

  const mappedEquipment = BODY_TYPES.find((b) => b.id === bodyType)?.equipment;


  return (
    <AppShell
      title={
        <span className="flex items-center gap-3">
          <Link
            to="/board"
            aria-label="Back"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border bg-card"
          >
            <ArrowLeft className="size-5" />
          </Link>
          <TruckImage size="sm" glowColor={truckColor} />
          Settings
        </span>
      }
    >
      <div className="space-y-4">
        <section className="rounded-md border border-border bg-card p-4">
          <h2 className="ez-section-title">Truck appearance</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Only changes the picture in the app.
          </p>

          <div className="mt-4 grid grid-cols-3 gap-3">
            {BODY_TYPES.map(({ id, label, equipment }) => {
              const active = bodyType === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setBodyType(id);
                    if (equipment) saveEquipment.mutate(equipment);
                  }}
                  aria-pressed={active}
                  className={`flex min-h-16 items-center justify-center overflow-hidden rounded-md border p-3 text-sm ${
                    active
                      ? "border-ez-amber bg-ez-amber/10 font-semibold text-ez-amber"
                      : "border-border bg-surface-2 text-muted-foreground"
                  }`}
                >
                  <span className="text-center leading-tight">{label}</span>
                </button>
              );
            })}
          </div>

          {mappedEquipment ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {saveEquipment.isPending ? "Saving…" : `Saved as: ${mappedEquipment}`}
            </p>
          ) : null}
          {saveEquipment.isError ? (
            <div className="mt-3">
              <ErrorBox error={saveEquipment.error} />
            </div>
          ) : null}


          <div className="mt-6 flex items-center justify-center rounded-md border border-border bg-surface-2 py-6">
            <TruckImage size="lg" glowColor={truckColor} />
          </div>

          <p className="mt-5 text-sm font-semibold">Glow color</p>
          <div className="mt-3 flex flex-wrap gap-3">
            {TRUCK_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                aria-label={c.name}
                aria-pressed={truckColor === c.value}
                onClick={() => setTruckColor(c.value)}
                className={`size-11 rounded-full border-2 ${
                  truckColor === c.value ? "border-foreground" : "border-border"
                }`}
                style={{ backgroundColor: c.value }}
              />
            ))}
          </div>
        </section>

        <section className="space-y-5">
          <div className="px-1">
            <h2 className="ez-section-title">Truck profile</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              These real numbers make every load score sharper.
            </p>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              <li>· Unit, size and hazmat</li>
              <li>· Fuel, upkeep and daily costs</li>
              <li>· Hours you have left to drive</li>
            </ul>
          </div>
          <TruckProfile />
        </section>
      </div>
    </AppShell>
  );
}
