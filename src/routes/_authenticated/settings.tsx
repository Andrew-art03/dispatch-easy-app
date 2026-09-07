import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowLeft, Truck as TruckIcon, Container, Caravan } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { TRUCK_COLORS, TruckGlyph, useTruckColor } from "@/components/GoalProgress";
import lowboyAsset from "@/assets/truck-lowboy.jpg.asset.json";
import gooseneckAsset from "@/assets/truck-gooseneck.jpg.asset.json";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content: "Pick how your truck looks in the app: body type and the glow color under it.",
      },
      { property: "og:title", content: "Settings — EZ Trucking Auto Dispatching" },
      {
        property: "og:description",
        content: "Personalize your truck's look inside EZ Trucking Auto Dispatching.",
      },
    ],
  }),
  component: SettingsPage,
});

// Visual-only: picks which silhouette shows in illustrations. Not the truck profile.
const BODY_TYPES = [
  { id: "bobtail", label: "Bobtail", icon: TruckIcon },
  { id: "semi", label: "18-Wheeler", icon: Container },
  { id: "van", label: "Van", icon: Caravan },
  { id: "lowboy", label: "Lowboy", image: lowboyAsset.url },
  { id: "gooseneck", label: "Gooseneck Trailer", image: gooseneckAsset.url },
];

function SettingsPage() {
  const [bodyType, setBodyType] = useState("semi");
  const [truckColor, setTruckColor] = useTruckColor();

  return (
    <AppShell
      title={
        <span className="flex items-center gap-3">
          <Link
            to="/board"
            aria-label="Back"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-border bg-card"
          >
            <ArrowLeft className="size-5" />
          </Link>
          Settings
        </span>
      }
    >
      <div className="space-y-4">
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-base font-semibold">Truck appearance</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Only changes the picture in the app.
          </p>

          <div className="mt-4 grid grid-cols-3 gap-3">
            {BODY_TYPES.map(({ id, label, icon: Icon, image }) => {
              const active = bodyType === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setBodyType(id)}
                  aria-pressed={active}
                  className={`flex min-h-24 flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border p-2 text-sm ${
                    active
                      ? "border-ez-amber bg-ez-amber/10 font-semibold text-ez-amber"
                      : "border-border bg-surface-2 text-muted-foreground"
                  }`}
                >
                  {image ? (
                    <img
                      src={image}
                      alt=""
                      aria-hidden="true"
                      loading="lazy"
                      width={1280}
                      height={768}
                      className="h-14 w-full rounded-lg object-cover"
                    />
                  ) : Icon ? (
                    <Icon className="size-7" />
                  ) : null}
                  <span className="min-h-10 content-center text-center leading-tight">{label}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-6 flex items-center justify-center rounded-xl border border-border bg-surface-2 py-6">
            <TruckGlyph color={truckColor} className="h-16 w-28" />
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
      </div>
    </AppShell>
  );
}
