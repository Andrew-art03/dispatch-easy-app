/**
 * Small, quiet label placed next to estimated or money figures.
 * Presentation only — it never changes a number.
 */
export function TrustCue({ label }: { label: string }) {
  return (
    <span className="ez-label ml-2 inline-flex items-center rounded border border-border/70 bg-transparent px-2 py-0.5 align-middle text-muted-foreground">
      {label}
    </span>
  );
}
