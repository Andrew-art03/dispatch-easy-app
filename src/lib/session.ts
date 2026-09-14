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

  // The `?? "My company"` is not belt-and-braces: `split("@")[0]` is `string | undefined`
  // under this tsconfig, and the old code hid that by casting the org name it read back
  // (`org["name"] as string`). With the name no longer coming back from the database
  // (see below), the type is honest again and the fallback has to be real.
  const companyName: string =
    (authUser.user_metadata?.["company_name"] as string | undefined) ||
    (authUser.email ? (authUser.email.split("@")[0] ?? "My company") : "My company");

  /**
   * The org id is chosen HERE, not returned by the insert, and that is load-bearing.
   *
   * This used to be `.insert({ name }).select("id, name").single()`. The insert itself was
   * always fine — `org_bootstrap_insert` is `with check (true)`. The `.select()` was not:
   * `RETURNING` makes Postgres apply the SELECT policy to the new row, that policy is
   * `org_self` (`id = auth.org_id()`), and on a first login `auth.org_id()` is still NULL
   * because the caller has no `user` row yet. So the org was created and then refused back
   * to its own creator, and every brand-new account failed to sign up with
   * "new row violates row-level security policy for table org".
   *
   * Found by tests/db/tenancy.test.ts, which is the first time this path had ever run
   * against a real database with the real policies on it.
   *
   * Generating the id client-side needs no RETURNING and weakens nothing. A client that
   * picked an existing org's id would fail on the primary key, and `user_bootstrap_insert`
   * still independently requires `id = auth.uid() and org_has_no_users(org_id)` — so this
   * cannot be used to walk into somebody else's tenant. Fixing the CLIENT rather than the
   * policy is also the only option open: the schema is frozen (BUILD_DEFAULTS §2), and
   * loosening `org_self` to make RETURNING work would make every org readable by everyone.
   */
  const orgId = crypto.randomUUID();
  const { error: orgError } = await supabase.from("org").insert({ id: orgId, name: companyName });
  if (orgError) throw orgError;

  const { error: userError } = await supabase.from("user").insert({
    id: authUser.id,
    org_id: orgId,
    role: "owner",
    full_name: (authUser.user_metadata?.["full_name"] as string | undefined) ?? null,
  });
  if (userError) throw userError;

  return {
    authUserId: authUser.id,
    email: authUser.email ?? null,
    orgId,
    orgName: companyName,
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
