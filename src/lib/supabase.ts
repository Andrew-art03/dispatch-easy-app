import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL =
  (import.meta.env["VITE_SUPABASE_URL"] as string | undefined) ??
  "https://efeaylkqgqhobookcqby.supabase.co";

export const SUPABASE_PUBLISHABLE_KEY =
  (import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] as string | undefined) ?? "";

export const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY || "missing-key", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
