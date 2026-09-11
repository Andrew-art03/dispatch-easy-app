import { Link } from "@tanstack/react-router";
import { Home, Search, FileText, Wallet, Truck, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { EZVoiceSheetHost, useEZVoice } from "@/components/EZVoice";
import { CopilotAvatar, useTruckColor } from "@/components/GoalProgress";

const NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: "/home", label: "Home", icon: Home },
  { to: "/hunt", label: "Hunt", icon: Search },
  { to: "/docs", label: "Docs", icon: FileText },
  { to: "/goal", label: "Week $", icon: Wallet },
  { to: "/settings", label: "Truck", icon: Truck },
];

/** The one way into EZ Copilot — pinned to the top of every screen. */
function CopilotEntry() {
  const [truckColor] = useTruckColor();
  const voice = useEZVoice();
  return (
    <button
      type="button"
      aria-label="EZ Copilot"
      onClick={() =>
        voice.openWith({
          transcript: "How can I help you today?",
          heard: [
            { label: "Action", value: "Find my next load", sure: false },
            { label: "Then", value: "Open EZ Copilot", sure: true },
          ],
          keepAmount: "$1,412",
          rpmLabel: "$2.41",
          verdictWord: "Take it",
        })
      }
      className="flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-ez-amber px-3"
    >
      <CopilotAvatar color={truckColor} className="size-6" />
      <span className="ez-label text-ez-amber">EZ Copilot</span>
    </button>
  );
}

export function AppShell({
  title,
  action,
  bottomSticky,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  bottomSticky?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex min-h-14 max-w-3xl items-center py-2 justify-between gap-3 px-4">
          <h1 className="ez-section-title min-w-0 flex-1 truncate">{title}</h1>
          <CopilotEntry />
          {action}
        </div>
      </header>

      <main className={cn("mx-auto max-w-3xl px-4 pt-4", bottomSticky ? "pb-36" : "pb-28")}>
        {children}
      </main>

      <EZVoiceSheetHost />


      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card pb-[max(0.35rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-3xl flex-col">
          {bottomSticky ? <div className="px-4 pb-2 pt-3">{bottomSticky}</div> : null}
          <div className="grid grid-cols-5">
            {NAV.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className="flex flex-col items-center gap-1 py-3 text-[10.5px] transition-colors"
                activeOptions={{ exact: false }}
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      className={cn(
                        "size-6",
                        isActive ? "text-ez-amber" : "text-muted-foreground",
                      )}
                      strokeWidth={1.75}
                    />
                    <span
                      className={cn(
                        "font-mono uppercase tracking-[0.08em]",
                        isActive
                          ? "font-semibold text-ez-amber"
                          : "text-muted-foreground",
                      )}
                    >
                      {label}
                    </span>
                  </>
                )}
              </Link>
            ))}
          </div>
        </div>
      </nav>
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-muted-foreground">
      <span className="size-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4">
      <p className="font-medium text-destructive">That didn't load</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      {onRetry ? (
        <button
          onClick={onRetry}
          className="mt-4 rounded-md border border-border px-3 py-2 text-sm font-medium"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-md border border-dashed border-border p-8 text-left">
      <p className="ez-card-title">{title}</p>
      {hint ? <p className="mt-1 text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
