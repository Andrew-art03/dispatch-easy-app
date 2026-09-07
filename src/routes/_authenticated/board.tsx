import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Settings, Radar } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { AppShell } from "@/components/AppShell";
import { useEZVoice } from "@/components/EZVoice";
import { GoalBar, useTruckColor } from "@/components/GoalProgress";
import { TrustCue } from "@/components/TrustCue";
import boardTruckAsset from "@/assets/board-truck-side-profile.png.asset.json";

export const Route = createFileRoute("/_authenticated/board")({
  head: () => ({
    meta: [
      { title: "Load board — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content:
          "Every load your truck is working, grouped from found to delivered, with true net and a take or skip call.",
      },
      { property: "og:title", content: "Load board — EZ Trucking Auto Dispatching" },
      {
        property: "og:description",
        content:
          "Every load your truck is working, from found to delivered, with true net and a verdict.",
      },
    ],
  }),
  component: BoardPage,
});

// Design-phase mock data — not wired to load/stop/score yet.
const WEEK = { earned: 2100, target: 3000 };

type Pill = { text: string; tone: "take" | "counter" };

type MockCard = {
  head: string;
  headTone?: "green" | "amber";
  route: string;
  money?: string;
  pill?: Pill;
  sub: string;
  note?: string;
  button?: string;
};

const SECTIONS: { title: string; count: number; cards: MockCard[] }[] = [
  {
    title: "Empty · Looking",
    count: 3,
    cards: [
      {
        head: "#4471 · Broker A · 6 min",
        route: "Dallas → Memphis",
        money: "$1,412 keep · $2.41/mi",
        pill: { text: "Take it", tone: "take" },
        sub: "$2,150 · 892 mi · 118 empty",
      },
      {
        head: "#4468 · Broker C · 11 min",
        route: "Amarillo → Oklahoma City",
        money: "$418 keep · $1.96/mi",
        pill: { text: "Counter", tone: "counter" },
        sub: "$780 · 271 mi · 12 empty · ask $850",
        note: "+1 stale · Lubbock → Denver · below floor",
      },
    ],
  },
  {
    title: "Counter out",
    count: 1,
    cards: [
      {
        head: "#4452 · Broker D · Waiting on broker",
        route: "Amarillo → Kansas City",
        money: "$611 keep at your ask · $2.08/mi",
        sub: "Offered $1,150 · asked $1,300 · detention 2h free requested",
        button: "Review draft reply",
      },
    ],
  },
  {
    title: "Booked",
    count: 1,
    cards: [
      {
        head: "#4431 · Broker A · Rate con matches",
        headTone: "green",
        route: "Fort Worth → Amarillo",
        money: "$702 keep · $2.22/mi",
        sub: "Pickup today 15:00 · Door 6 · confirmed by voice 9:12",
      },
    ],
  },
  {
    title: "Rolling · Done",
    count: 2,
    cards: [
      {
        head: "#4419 · Broker E · At dock · 0:42 free left",
        headTone: "amber",
        route: "Houston → Amarillo",
        sub: "Detention clock armed · broker notified",
      },
      {
        head: "#4402 · Broker A · Delivered · POD in",
        headTone: "green",
        route: "Odessa → Houston",
        money: "$1,380 kept · actual",
        sub: "Est. $1,348 · +$32 · lumper receipt unclaimed",
      },
    ],
  },
];

function BoardPage() {
  const voice = useEZVoice();
  const [truckColor] = useTruckColor();

  const openBoardVoice = () =>
    voice.openWith({
      transcript: "What's my best move today?",
      heard: [
        { label: "Truck", value: "Unit 12", sure: true },
        { label: "Load", value: "#4471", sure: true },
        { label: "Action", value: "Review this load", sure: false },
      ],
      keepAmount: "$1,412",
      rpmLabel: "$2.41",
      verdictWord: "Take it",
    });

  const truckQuery = useQuery({
    queryKey: ["board-truck"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("truck")
        .select("unit_number")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as { unit_number: string } | null;
    },
  });

  const hasTruck = Boolean(truckQuery.data?.unit_number);
  const progress = WEEK.earned / WEEK.target;

  return (
    <AppShell
      title="Board"
      action={
        <div className="flex items-center gap-2">
          <button
            onClick={() => setVoiceOpen(true)}
            className="min-h-11 rounded-xl border border-ez-amber px-4 text-sm font-semibold text-ez-amber"
          >
            Talk to EZ
          </button>
          <Link
            to="/settings"
            aria-label="Settings"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-border bg-card"
          >
            <Settings className="size-5 text-muted-foreground" />
          </Link>
        </div>
      }
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-base font-semibold">
          Morning, Andrew. Unit 12 is empty in Amarillo.
        </p>
        <span className="rounded-full border border-border px-3 py-1 text-sm">Needs you · 4</span>
      </div>

      {!hasTruck ? (
        <section className="mb-4 rounded-2xl border border-ez-amber/40 bg-card p-5">
          <div className="flex items-start gap-3">
            <span className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-ez-amber/50 bg-surface-2">
              <img
                src={boardTruckAsset.url}
                alt="Silver semi truck"
                draggable={false}
                className="h-11 w-16 max-w-none select-none object-contain"
                style={{
                  transform: "rotate(-3deg)",
                  filter: `drop-shadow(0 3px 4px rgba(0,0,0,0.55)) drop-shadow(0 7px 7px ${truckColor})`,
                }}
              />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">Add your truck to get sharper numbers</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                No loads on the board yet. Your fuel, upkeep and hours are what turn a rate into
                what you actually keep.
              </p>
            </div>
          </div>
          <ul className="mt-4 space-y-1 text-sm text-muted-foreground">
            <li>· Unit, size and hazmat</li>
            <li>· Fuel, upkeep and daily costs</li>
            <li>· Hours you have left to drive</li>
          </ul>
          <div className="mt-4">
            <Link to="/settings" className="ez-btn-amber text-center">
              Set up my truck
            </Link>
          </div>
        </section>
      ) : null}

      {/* EZ's Pick */}
      <section className="relative mb-4 overflow-hidden rounded-2xl border border-ez-amber/60 bg-card p-5">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-ez-amber" />
          <span className="text-xs font-semibold uppercase tracking-wide text-ez-amber">
            EZ's pick
          </span>
        </div>
        <p className="mt-3 text-xl font-semibold">Amarillo → Dallas → Memphis</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Ready 2 PM · reposition 118 mi · #4471 Thu 6 AM · home Sat · floor $1.85
        </p>

        <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          You keep about
        </p>
        <p className="ez-num text-5xl">
          $1,412
          <TrustCue label="Estimated net" />
        </p>
        <p className="ez-num text-base text-muted-foreground">$2.41 all-in/mi · high conf.</p>

        <ul className="mt-4 flex flex-wrap gap-4 text-sm">
          <li className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-ez-green" />
            Fits
          </li>
          <li className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-ez-green" />
            Pays
          </li>
          <li className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-ez-amber" />
            Your floor
            <span className="text-muted-foreground">· market not verified</span>
          </li>
        </ul>

        <p className="mt-4 text-sm">
          <span className="font-semibold">One thing to do:</span> say yes to Memphis
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Your approval required — EZ books nothing on its own.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <button className="ez-btn-primary">See the load</button>
          <button className="ez-btn-secondary">Needs you 2</button>
        </div>
      </section>

      {/* Your week */}
      <section className="mb-6 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Your week
          </span>
          <span className="ez-num">
            $2,100 <span className="text-muted-foreground">of $3,000</span>
          </span>
        </div>
        <div className="mt-8">
          <GoalBar progress={progress} truckColor={truckColor} />
        </div>
        <p className="mt-2 text-sm text-muted-foreground">$900 to go · Memphis gets you there</p>
      </section>

      <div className="space-y-6">
        {SECTIONS.map((section) => (
          <section key={section.title}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {section.title} · {section.count}
            </h2>
            <ul className="space-y-2">
              {section.cards.map((card) => (
                <li key={card.head} className="rounded-xl border border-border bg-card p-4">
                  <p
                    className={`ez-ref truncate ${
                      card.headTone === "green"
                        ? "text-ez-green"
                        : card.headTone === "amber"
                          ? "text-ez-amber"
                          : "text-muted-foreground"
                    }`}
                  >
                    {card.head}
                  </p>
                  <div className="mt-1 flex items-start justify-between gap-3">
                    <p className="min-w-0 truncate font-semibold">{card.route}</p>
                    {card.pill ? (
                      <span
                        className={`inline-flex shrink-0 items-center rounded-full px-3 py-1 text-xs font-semibold ${
                          card.pill.tone === "take"
                            ? "bg-ez-green text-primary-foreground"
                            : "bg-ez-amber text-accent-foreground"
                        }`}
                      >
                        {card.pill.text}
                      </span>
                    ) : null}
                  </div>
                  {card.money ? (
                    <p className="ez-num mt-2 text-xl">
                      {card.money}
                      <TrustCue label="Estimated net" />
                    </p>
                  ) : null}
                  <p className="mt-1 text-sm text-muted-foreground">{card.sub}</p>
                  {card.note ? <p className="mt-2 text-sm text-ez-red">{card.note}</p> : null}
                  {card.button ? (
                    <>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Draft only — nothing sent yet.
                      </p>
                      <button className="ez-btn-secondary mt-2">{card.button}</button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Radar className="size-4 text-ez-amber" />
        Scout · Hunting for Unit 12 · 3 found · last 4 min ago
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        EZ is watching your lane · say "find me a load out of Amarillo" · MC 1234567
      </p>

      <EZVoiceSheet
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        transcript="What's my best move today?"
        heard={[
          { label: "Truck", value: "Unit 12", sure: true },
          { label: "Load", value: "#4471", sure: true },
          { label: "Action", value: "Review this load", sure: false },
        ]}
        keepAmount="$1,412"
        rpmLabel="$2.41"
        verdictWord="Take it"
      />
    </AppShell>
  );
}
