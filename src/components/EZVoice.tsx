import { useEffect, useState, useSyncExternalStore } from "react";
import { Mic, X } from "lucide-react";

export type VoiceHeard = {
  label: string;
  value: string;
  sure: boolean;
};

export type VoiceProps = {
  transcript: string;
  heard: VoiceHeard[];
  keepAmount: string;
  rpmLabel: string;
  verdictWord: string;
  onConfirm?: () => void;
  confirmDisabled?: boolean;
  confirmLabel?: string;
};

/**
 * Voice confirm sheet — presentation only.
 * No speech recognition, no network, no AI. It shows scripted content and
 * hands the confirm action back to the caller (which hits the existing endpoint).
 *
 * State lives in a module-level store so closing the sheet hides it without
 * discarding the last exchange — reopening shows the same conversation.
 */
type VoiceState = {
  open: boolean;
  props: VoiceProps | null;
};

let state: VoiceState = { open: false, props: null };
const listeners = new Set<() => void>();

function emit(next: Partial<VoiceState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useEZVoice() {
  return {
    openWith: (props: VoiceProps) => emit({ open: true, props }),
    close: () => emit({ open: false }),
    reopen: () => emit({ open: true }),
  };
}

export function EZVoiceSheetHost() {
  const { open, props } = useSyncExternalStore(subscribe, () => state);
  return <EZVoiceSheet open={open} props={props} />;
}

export function EZVoiceSheet({ open, props }: { open: boolean; props: VoiceProps | null }) {
  const transcript = props?.transcript ?? "";
  const [typed, setTyped] = useState(transcript);

  useEffect(() => {
    if (!open) return;
    // Keep whatever was typed before close; only animate fresh text forward.
    if (typed.length >= transcript.length) return;
    let i = typed.length;
    const timer = setInterval(() => {
      i += 1;
      setTyped(transcript.slice(0, i));
      if (i >= transcript.length) clearInterval(timer);
    }, 45);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, transcript]);

  if (!open || !props) return null;

  const {
    heard,
    keepAmount,
    rpmLabel,
    verdictWord,
    onConfirm,
    confirmDisabled,
    confirmLabel = "Confirm load",
  } = props;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/85 backdrop-blur-sm sm:items-center">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-border bg-card p-5 sm:rounded-3xl">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-lg font-semibold">EZ is listening</p>
            <p className="text-sm text-muted-foreground">Say what you want to do.</p>
          </div>
          <button
            onClick={() => emit({ open: false })}
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

        <h2 className="mt-5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
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

        <button
          onClick={onConfirm}
          disabled={confirmDisabled || !onConfirm}
          style={{ minHeight: 64 }}
          className="ez-btn-primary mt-5 disabled:opacity-40"
        >
          {confirmLabel}
        </button>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <button onClick={() => emit({ open: false })} className="ez-btn-secondary">
            Correct
          </button>
          <button onClick={() => emit({ open: false })} className="ez-btn-secondary">
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
