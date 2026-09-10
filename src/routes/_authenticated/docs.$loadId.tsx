import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { authedFetch, useMe } from "@/lib/session";
import { AppShell, Empty, ErrorBox, Loading } from "@/components/AppShell";
import type { DocumentRow, DocumentType } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/docs/$loadId")({
  head: () => ({
    meta: [
      { title: "Paperwork — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content: "Snap the rate con, BOL, POD and receipts for this load and bundle them into one PDF.",
      },
      { property: "og:title", content: "Paperwork — EZ Trucking Auto Dispatching" },
      {
        property: "og:description",
        content: "Snap the rate con, BOL, POD and receipts and bundle them into one PDF.",
      },
    ],
  }),
  component: DocsPage,
});

const TYPES: { value: DocumentType; label: string }[] = [
  { value: "rate_con", label: "Rate con" },
  { value: "bol", label: "BOL" },
  { value: "pod", label: "POD" },
  { value: "fuel_receipt", label: "Fuel receipt" },
  { value: "lumper_receipt", label: "Lumper receipt" },
  { value: "scale_ticket", label: "Scale ticket" },
  { value: "inspection", label: "Inspection" },
  { value: "other", label: "Other" },
];

function DocsPage() {
  const { loadId } = useParams({ from: "/_authenticated/docs/$loadId" });
  const me = useMe();
  const queryClient = useQueryClient();
  const [docType, setDocType] = useState<DocumentType>("rate_con");
  const [packNote, setPackNote] = useState<string | null>(null);
  const [packError, setPackError] = useState<string | null>(null);

  const docsQuery = useQuery({
    queryKey: ["documents", loadId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document")
        .select("id, load_id, type, storage_path, created_at")
        .eq("load_id", loadId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as unknown as DocumentRow[];
      const withUrls = await Promise.all(
        rows.map(async (row) => {
          const { data: signed } = await supabase.storage
            .from("docs")
            .createSignedUrl(row.storage_path, 3600);
          return { ...row, url: signed?.signedUrl ?? null };
        }),
      );
      return withUrls;
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const orgId = me.data?.orgId;
      if (!orgId) throw new Error("No company found for your account.");
      const path = `${orgId}/${loadId}/${docType}-${Date.now()}-${file.name.replace(/[^\w.-]/g, "_")}`;
      const { error: uploadError } = await supabase.storage.from("docs").upload(path, file);
      if (uploadError) throw uploadError;
      const { error } = await supabase.from("document").insert({
        org_id: orgId,
        load_id: loadId,
        type: docType,
        storage_path: path,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["documents", loadId] }),
  });

  const bundle = useMutation({
    mutationFn: async () => {
      const res = await authedFetch(`/api/loads/${loadId}/pack.pdf`);
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not build the packet.");
      return body.message ?? "Packet requested.";
    },
    onSuccess: (m) => {
      setPackError(null);
      setPackNote(m);
    },
    onError: (e) => {
      setPackNote(null);
      setPackError(e instanceof Error ? e.message : "Could not build the packet.");
    },
  });

  return (
    <AppShell title="Paperwork">
      <div className="space-y-5">
        <section className="space-y-4 rounded-2xl border border-border bg-card p-5">
          <label className="block">
            <span className="mb-1 block text-sm text-muted-foreground">What is this?</span>
            <select
              className="ez-input"
              value={docType}
              onChange={(e) => setDocType(e.target.value as DocumentType)}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          <label className="ez-btn-amber block w-full cursor-pointer text-center">
            {upload.isPending ? "Uploading…" : "Take a photo or upload"}
            <input
              type="file"
              accept="image/*,application/pdf"
              capture="environment"
              className="sr-only"
              disabled={upload.isPending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
                e.target.value = "";
              }}
            />
          </label>
          {upload.isError ? <ErrorBox error={upload.error} /> : null}
        </section>

        {docsQuery.isPending ? <Loading label="Loading paperwork…" /> : null}
        {docsQuery.isError ? (
          <ErrorBox error={docsQuery.error} onRetry={() => docsQuery.refetch()} />
        ) : null}
        {docsQuery.data ? (
          docsQuery.data.length === 0 ? (
            <Empty title="No paperwork yet" hint="Snap the rate con to start." />
          ) : (
            <ul className="grid grid-cols-3 gap-3">
              {docsQuery.data.map((doc) => (
                <li key={doc.id} className="overflow-hidden rounded-xl border border-border bg-card">
                  {doc.url ? (
                    <a href={doc.url} target="_blank" rel="noreferrer">
                      <img
                        src={doc.url}
                        alt={doc.type}
                        loading="lazy"
                        className="h-24 w-full bg-secondary object-cover"
                      />
                    </a>
                  ) : (
                    <div className="h-24 w-full bg-secondary" />
                  )}
                  <p className="p-2 text-xs text-muted-foreground">{doc.type.replace(/_/g, " ")}</p>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {packError ? <ErrorBox error={new Error(packError)} /> : null}
        {packNote ? (
          <p className="rounded-xl border border-border bg-card p-3 text-sm text-ez-green">{packNote}</p>
        ) : null}

        <button
          onClick={() => bundle.mutate()}
          disabled={bundle.isPending}
          className="ez-btn-secondary disabled:opacity-40"
        >
          {bundle.isPending ? "Building…" : "Bundle PDF"}
        </button>
      </div>
    </AppShell>
  );
}
