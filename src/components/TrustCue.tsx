/**
 * Small, quiet label placed next to estimated or money figures.
 * Presentation only — it never changes a number.
 */
export function TrustCue({ label }: { label: string }) {
  return (
    <span className="ml-2 inline-flex items-center rounded-full border border-border/70 bg-secondary/50 px-2 py-0.5 align-middle text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
  );
}
