import { Link } from "@tanstack/react-router";
import { Home, Search, FileText, Wallet, Truck as TruckIcon, LayoutList } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { EZPresence } from "@/components/EZPresence";
import { EZVoiceSheetHost } from "@/components/EZVoice";

const NAV: { to: string; label: string; icon: typeof LayoutList; amber?: boolean }[] = [
  { to: "/settings", label: "Truck", icon: TruckIcon },
  { to: "/home", label: "Home", icon: Home },
  { to: "/hunt", label: "Hunt", icon: Search, amber: true },
  { to: "/docs", label: "Docs", icon: FileText },
  { to: "/goal", label: "Week $", icon: Wallet },
];

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
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{title}</h1>
          {action}
        </div>
      </header>

      <main className={cn("mx-auto max-w-3xl px-4 pt-4", bottomSticky ? "pb-36" : "pb-28")}>
        {children}
      </main>

      <EZPresence />
      <EZVoiceSheetHost />

      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card">
        <div className="mx-auto flex max-w-3xl flex-col">
          {bottomSticky ? <div className="px-4 pb-2 pt-3">{bottomSticky}</div> : null}
          <div className="grid grid-cols-5">
            {NAV.map(({ to, label, icon: Icon, amber }) => (
              <Link
                key={to}
                to={to}
                className="flex flex-col items-center gap-1 py-3 text-xs transition-colors"
                activeOptions={{ exact: false }}
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      className={cn(
                        "size-6",
                        isActive
                          ? amber
                            ? "text-ez-amber"
                            : "text-ez-amber"
                          : "text-muted-foreground",
                      )}
                    />
                    <span
                      className={cn(
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
    <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-4">
      <p className="font-medium text-destructive">That didn't load</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      {onRetry ? (
        <button
          onClick={onRetry}
          className="mt-3 rounded-lg border border-border px-3 py-2 text-sm font-medium"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center">
      <p className="font-medium">{title}</p>
      {hint ? <p className="mt-1 text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
