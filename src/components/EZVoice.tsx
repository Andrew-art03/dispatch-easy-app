import { useEffect, useState } from "react";
import { Mic, X } from "lucide-react";

export type VoiceHeard = {
  label: string;
  value: string;
  sure: boolean;
};

/**
 * Voice confirm sheet — presentation only.
 * No speech recognition, no network, no AI. It shows what EZ understood and
 * hands the confirm action back to the caller (which hits the existing endpoint).
 */
export function EZVoiceSheet({
  open,
  onClose,
  transcript,
  heard,
  keepAmount,
  rpmLabel,
  verdictWord,
  onConfirm,
  confirmDisabled,
  confirmLabel = "Confirm load",
}: {
  open: boolean;
  onClose: () => void;
  transcript: string;
  heard: VoiceHeard[];
  keepAmount: string;
  rpmLabel: string;
  verdictWord: string;
  onConfirm?: () => void;
  confirmDisabled?: boolean;
  confirmLabel?: string;
}) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) {
      setTyped("");
      return;
    }
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      setTyped(transcript.slice(0, i));
      if (i >= transcript.length) clearInterval(timer);
    }, 45);
    return () => clearInterval(timer);
  }, [open, transcript]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/85 backdrop-blur-sm sm:items-center">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-border bg-card p-5 sm:rounded-3xl">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-lg font-semibold">EZ is listening</p>
            <p className="text-sm text-muted-foreground">Say what you want to do.</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-11 items-center justify-center rounded-full border border-border text-muted-foreground"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="my-6 flex justify-center">
          <div className="relative flex size-32 items-center justify-center">
            <span className="ez-ring absolute inset-0 rounded-full border-4 border-ez-amber" />
            <span className="absolute inset-4 rounded-full border border-ez-amber/50" />
            <Mic className="size-10 text-ez-amber" />
          </div>
        </div>

        <p className="min-h-6 text-center text-base text-ez-amber">
          {typed}
          <span className="ml-0.5 animate-pulse">|</span>
        </p>

        <section className="mt-5 rounded-2xl border border-border bg-surface-2 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            I heard …
          </h2>
          <ul className="mt-3 space-y-2 text-sm">
            {heard.map((item) => (
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
              <p className="ez-num text-2xl">{keepAmount}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">All-in / mi</p>
              <p className="ez-num text-2xl">{rpmLabel}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">EZ's call</p>
              <p className="ez-num text-2xl">{verdictWord}</p>
            </div>
          </div>
        </section>

        <button
          onClick={onConfirm}
          disabled={confirmDisabled || !onConfirm}
          style={{ minHeight: 64 }}
          className="ez-btn-primary mt-5 disabled:opacity-40"
        >
          {confirmLabel}
        </button>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <button onClick={onClose} className="ez-btn-secondary">
            Correct
          </button>
          <button onClick={onClose} className="ez-btn-secondary">
            Not this
          </button>
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Hold the ring to talk · Type instead
        </p>
      </div>
    </div>
  );
}

export function EZStatusLine({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-ez-amber">
      <span className="size-2 shrink-0 rounded-full bg-ez-amber" />
      <span className="truncate">{text}</span>
    </p>
  );
}
