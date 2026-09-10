import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowLeft, Mic } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import {
  CopilotAvatar,
  TRUCK_COLORS,
  useTruckColor,
} from "@/components/GoalProgress";
import { useEZVoice } from "@/components/EZVoice";

export const Route = createFileRoute("/_authenticated/copilot")({
  head: () => ({
    meta: [
      { title: "EZ Copilot — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content:
          "Work with EZ Copilot: ask for a load, check your week, or see what still needs you.",
      },
      { property: "og:title", content: "EZ Copilot — EZ Trucking Auto Dispatching" },
      {
        property: "og:description",
        content: "A workspace for asking EZ Copilot what to do next with your truck.",
      },
    ],
  }),
  component: CopilotPage,
});

/**
 * Scripted workspace — presentation only. No speech recognition, no network,
 * no AI calls, no tables touched. Same mock content the voice sheet shows.
 */
type Result = {
  transcript: string;
  heard: { label: string; value: string; sure: boolean }[];
  keepAmount: string;
  rpmLabel: string;
  verdictWord: string;
};

const ACTIONS: { id: string; label: string; hint: string; result: Result }[] = [
  {
    id: "find",
    label: "Find a load",
    hint: "Best paying move from where you sit",
    result: {
      transcript: "Find me a load out of Amarillo.",
      heard: [
        { label: "Truck", value: "Unit 12", sure: true },
        { label: "Load", value: "#4471 Dallas → Memphis", sure: true },
        { label: "Action", value: "Pursue this load", sure: false },
      ],
      keepAmount: "$1,412",
      rpmLabel: "$2.41",
      verdictWord: "Take it",
    },
  },
  {
    id: "week",
    label: "Check my week",
    hint: "Where you stand against your payout goal",
    result: {
      transcript: "How is my week looking?",
      heard: [
        { label: "Week", value: "Sep 1 – Sep 7", sure: true },
        { label: "Kept so far", value: "$3,400", sure: true },
        { label: "Left to goal", value: "$2,600", sure: false },
      ],
      keepAmount: "$3,400",
      rpmLabel: "$2.18",
      verdictWord: "On pace",
    },
  },
  {
    id: "needs",
    label: "What needs me",
    hint: "Only the steps a human has to do",
    result: {
      transcript: "What still needs me?",
      heard: [
        { label: "Confirm", value: "#4431 rate con ready", sure: true },
        { label: "Upload", value: "POD for #4402", sure: true },
        { label: "Reply", value: "Counter on #4452", sure: false },
      ],
      keepAmount: "$702",
      rpmLabel: "$2.22",
      verdictWord: "3 open",
    },
  },
];

function CopilotPage() {
  const [truckColor, setTruckColor] = useTruckColor();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const voice = useEZVoice();
  const openCopilotVoice = () => {
    const demo = ACTIONS[0]!.result;
    voice.openWith({
      transcript: demo.transcript,
      heard: demo.heard,
      keepAmount: demo.keepAmount,
      rpmLabel: demo.rpmLabel,
      verdictWord: demo.verdictWord,
      confirmLabel: "Confirm load",
    });
  };
  const active = ACTIONS.find((a) => a.id === activeId)?.result ?? null;
  const showActions = asking || activeId !== null;

  return (
    <AppShell
      title={
        <span className="flex min-w-0 items-center gap-2">
          <Link
            to="/board"
            aria-label="Back"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-border bg-card"
          >
            <ArrowLeft className="size-5" />
          </Link>
           <span className="truncate">EZ Truck Copilot</span>
        </span>
      }
    >

      {/* Avatar stage — neon frame lit in the driver's chosen glow color. */}
      <section
        className="relative overflow-hidden rounded-3xl bg-background"
        style={{
          border: `2px solid ${truckColor}`,
          boxShadow: `0 0 28px ${truckColor}66, inset 0 0 40px ${truckColor}22`,
        }}
      >
        <CopilotAvatar color={truckColor} className="mx-auto size-56 sm:size-80" />
      </section>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Glow color</p>
          <div className="mt-2 flex gap-3">
            {TRUCK_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setTruckColor(c.value)}
                aria-label={c.name}
                aria-pressed={truckColor === c.value}
                className="size-11 rounded-full"
                style={{
                  backgroundColor: c.value,
                  outline: truckColor === c.value ? `3px solid ${c.value}` : "none",
                  outlineOffset: 3,
                }}
              />
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setAsking(true)}
          className="ml-auto flex min-h-12 items-center rounded-full border border-border bg-card px-5 text-base font-medium"
        >
          How can I help you today?
        </button>
      </div>

      <p className="mt-5 text-sm text-muted-foreground">
        Unit 12 · empty in Amarillo · hunting ON
      </p>

      {showActions ? (
        <>
      <h2 className="mt-6 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        What do you want to do?
      </h2>
      <div className="mt-3 space-y-3">
        {ACTIONS.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => setActiveId(action.id)}
            aria-pressed={activeId === action.id}
            className={`w-full rounded-2xl border p-4 text-left ${
              activeId === action.id
                ? "border-ez-amber bg-ez-amber/10"
                : "border-border bg-card"
            }`}
            style={{ minHeight: 72 }}
          >
            <p className="text-base font-semibold">{action.label}</p>
            <p className="mt-1 text-sm text-muted-foreground">{action.hint}</p>
          </button>
        ))}
      </div>

      {active ? (
        <section className="mt-6">
          <p className="text-base text-ez-amber">{active.transcript}</p>

          <h2 className="mt-5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            I heard …
          </h2>
          <ul className="mt-3 space-y-2 text-sm">
            {active.heard.map((item) => (
              <li key={item.label} className="flex items-start gap-2">
                <span
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${
                    item.sure ? "bg-ez-green" : "bg-ez-amber"
                  }`}
                />
                <span className="text-muted-foreground">{item.label}</span>
                <span className="ml-auto text-right font-medium">{item.value}</span>
              </li>
            ))}
          </ul>

          <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
            <div>
              <p className="text-xs text-muted-foreground">You keep</p>
              <p className="ez-num text-2xl">{active.keepAmount}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">All-in / mi</p>
              <p className="ez-num text-2xl">{active.rpmLabel}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">EZ's call</p>
              <p className="ez-num text-2xl">{active.verdictWord}</p>
            </div>
          </div>

          <p className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Mic className="size-4" />
            Demo answers · nothing is sent anywhere yet
          </p>
        </section>
      ) : null}
        </>
      ) : null}
    </AppShell>
  );
}
