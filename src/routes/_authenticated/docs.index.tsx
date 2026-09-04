import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FileText } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useMe } from "@/lib/session";
import { AppShell, Empty, ErrorBox, Loading } from "@/components/AppShell";
import type { DocumentType } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/docs/")({
  head: () => ({
    meta: [
      { title: "Paperwork — EZ Trucking Auto Dispatching" },
      {
        name: "description",
        content: "Every rate con, BOL, POD and receipt you snapped, in one place.",
      },
      { property: "og:title", content: "Paperwork — EZ Trucking Auto Dispatching" },
      {
        property: "og:description",
        content: "Every rate con, BOL, POD and receipt you snapped, in one place.",
      },
    ],
  }),
  component: DocsIndexPage,
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

type Row = {
  id: string;
  load_id: string | null;
  type: string;
  storage_path: string;
  created_at: string | null;
  load: { reference: string | null } | { reference: string | null }[] | null;
};

function loadRef(row: Row) {
  const l = Array.isArray(row.load) ? row.load[0] : row.load;
  return l?.reference ?? null;
}

function DocsIndexPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [docType, setDocType] = useState<DocumentType>("rate_con");

  const docsQuery = useQuery({
    queryKey: ["documents", "all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document")
        .select("id, load_id, type, storage_path, created_at, load:load_id(reference)")
        .order("created_at", { ascending: false })
        .limit(60);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Row[];
      return Promise.all(
        rows.map(async (row) => {
          const { data: signed } = await supabase.storage
            .from("docs")
            .createSignedUrl(row.storage_path, 3600);
          return { ...row, url: signed?.signedUrl ?? null };
        }),
      );
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const orgId = me.data?.orgId;
      if (!orgId) throw new Error("No company found for your account.");
      const path = `${orgId}/inbox/${docType}-${Date.now()}-${file.name.replace(/[^\w.-]/g, "_")}`;
      const { error: uploadError } = await supabase.storage.from("docs").upload(path, file);
      if (uploadError) throw uploadError;
      const { error } = await supabase.from("document").insert({
        org_id: orgId,
        type: docType,
        storage_path: path,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["documents"] }),
  });

  return (
    <AppShell title="Paperwork">
      <div className="space-y-4">
        <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
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

          <label className="ez-btn-primary block w-full cursor-pointer text-center">
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
            <ul className="space-y-2">
              {docsQuery.data.map((doc) => {
                const ref = loadRef(doc);
                return (
                  <li
                    key={doc.id}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card p-3"
                  >
                    <div className="size-14 shrink-0 overflow-hidden rounded-lg bg-secondary">
                      {doc.url && !doc.storage_path.toLowerCase().endsWith(".pdf") ? (
                        <img
                          src={doc.url}
                          alt={doc.type}
                          loading="lazy"
                          className="size-14 object-cover"
                        />
                      ) : (
                        <div className="flex size-14 items-center justify-center">
                          <FileText className="size-6 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="inline-block rounded-full border border-ez-amber/30 bg-ez-amber/10 px-2 py-0.5 text-xs font-semibold text-ez-amber">
                        {doc.type.replace(/_/g, " ")}
                      </span>
                      <p className="mt-1 truncate text-sm">
                        {ref ? <span className="ez-ref">{ref}</span> : "No load attached"}
                      </p>
                      {doc.created_at ? (
                        <p className="text-xs text-muted-foreground">
                          {new Date(doc.created_at).toLocaleDateString()}
                        </p>
                      ) : null}
                    </div>
                    {doc.url ? (
                      <a
                        href={doc.url}
                        target="_blank"
                        rel="noreferrer"
                        className="min-h-11 shrink-0 rounded-lg border border-border px-3 py-2 text-sm"
                      >
                        Open
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </div>
    </AppShell>
  );
}
