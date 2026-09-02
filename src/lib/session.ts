import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";

export type Me = {
  authUserId: string;
  email: string | null;
  orgId: string;
  orgName: string;
  fullName: string | null;
  role: string;
};

/**
 * Reads the signed-in user's row. On very first login it bootstraps one org
 * plus one "user" row (the bootstrap insert policies already exist).
 */
export async function loadOrBootstrapMe(): Promise<Me> {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) throw new Error("Not signed in");
  const authUser = auth.user;

  const { data: existing, error: readError } = await supabase
    .from("user")
    .select("id, org_id, role, full_name, org:org_id(name)")
    .eq("id", authUser.id)
    .maybeSingle();
  if (readError) throw readError;

  if (existing) {
    const org = existing["org"] as { name: string } | { name: string }[] | null;
    const orgName = Array.isArray(org) ? (org[0]?.name ?? "My company") : (org?.name ?? "My company");
    return {
      authUserId: authUser.id,
      email: authUser.email ?? null,
      orgId: existing["org_id"] as string,
      orgName,
      fullName: (existing["full_name"] as string | null) ?? null,
      role: (existing["role"] as string) ?? "owner",
    };
  }

  const companyName =
    (authUser.user_metadata?.["company_name"] as string | undefined) ||
    (authUser.email ? authUser.email.split("@")[0] : "My company");

  const { data: org, error: orgError } = await supabase
    .from("org")
    .insert({ name: companyName })
    .select("id, name")
    .single();
  if (orgError) throw orgError;

  const { error: userError } = await supabase.from("user").insert({
    id: authUser.id,
    org_id: org["id"],
    role: "owner",
    full_name: (authUser.user_metadata?.["full_name"] as string | undefined) ?? null,
  });
  if (userError) throw userError;

  return {
    authUserId: authUser.id,
    email: authUser.email ?? null,
    orgId: org["id"] as string,
    orgName: org["name"] as string,
    fullName: (authUser.user_metadata?.["full_name"] as string | undefined) ?? null,
    role: "owner",
  };
}

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: loadOrBootstrapMe,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export async function authedFetch(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}
