import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase, supabaseConfigured } from "@/lib/supabase";
import { loadOrBootstrapMe } from "@/lib/session";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content: "Sign in to EZ Trucking Auto Dispatching to run your truck, your loads and your money from your phone.",
      },
      { property: "og:title", content: "Sign in — EZ Trucking Auto Dispatching" },
      {
        property: "og:description",
        content: "Sign in to run your truck, your loads and your money from your phone.",
      },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/board" });
    });
  }, [navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { company_name: company } },
        });
        if (signUpError) throw signUpError;
        if (!data.session) {
          setNotice("Check your email to confirm, then sign in.");
          setMode("signin");
          return;
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      }
      await loadOrBootstrapMe();
      navigate({ to: "/board" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function magicLink() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: linkError } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/board` },
      });
      if (linkError) throw linkError;
      setNotice("We sent you a sign-in link. Check your email.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-primary text-2xl font-black text-primary-foreground">
            EZ
          </div>
          <h1 className="text-2xl font-bold">EZ Trucking</h1>
          <p className="text-sm text-muted-foreground">Auto dispatching for owner-operators</p>
        </div>

        {!supabaseConfigured ? (
          <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-muted-foreground">
            Missing database key. Add VITE_SUPABASE_PUBLISHABLE_KEY to your environment.
          </div>
        ) : null}

        <div className="mb-4 grid grid-cols-2 rounded-xl border border-border p-1">
          {(["signin", "signup"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-lg py-2 text-sm font-medium ${
                mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {m === "signin" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-3">
          {mode === "signup" ? (
            <Field label="Company name">
              <input
                className="ez-input"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Arteaga Trucking LLC"
                required
              />
            </Field>
          ) : null}
          <Field label="Email">
            <input
              className="ez-input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <Field label="Password">
            <input
              className="ez-input"
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
            />
          </Field>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {notice ? <p className="text-sm text-primary">{notice}</p> : null}

          <button type="submit" disabled={busy} className="ez-btn-primary w-full">
            {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        <button
          type="button"
          onClick={magicLink}
          disabled={busy || !email}
          className="mt-3 w-full rounded-xl border border-border py-3 text-sm font-medium text-muted-foreground disabled:opacity-50"
        >
          Email me a sign-in link
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
