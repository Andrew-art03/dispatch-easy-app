import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { ErrorBox } from "@/components/AppShell";

const CATEGORIES = [
  "fuel",
  "truck wash",
  "food",
  "maintenance",
  "tolls",
  "lumper",
  "scale",
  "other",
];

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function AddExpenseSheet({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState(CATEGORIES[0]!);
  const [amount, setAmount] = useState("");
  const [at, setAt] = useState(today());
  const [loadId, setLoadId] = useState("");

  // Loads for this org come back RLS-scoped — no org_id filter from the client.
  const loadsQuery = useQuery({
    queryKey: ["loads-for-expense"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("load")
        .select("id, reference")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as { id: string; reference: string | null }[];
    },
  });

  const value = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(value) && value > 0;

  const save = useMutation({
    mutationFn: async () => {
      if (!valid) throw new Error("Enter an amount bigger than zero.");
      // org_id is filled by the database default (current_org_id()) — never sent from here.
      const { error } = await supabase.from("ledger_line").insert({
        category,
        amount: -Math.abs(value),
        at: new Date(`${at}T12:00:00`).toISOString(),
        load_id: loadId || null,
        source: "manual",
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["ledger"] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/70" role="dialog" aria-modal="true">
      <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border-t border-border bg-card p-5 pb-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add expense</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-11 items-center justify-center rounded-xl border border-border"
          >
            <X className="size-5" />
          </button>
        </div>

        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <label className="block">
            <span className="text-sm font-medium">What was it for</span>
            <select
              className="ez-input mt-2"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium">Amount</span>
            <input
              className="ez-input mt-2"
              inputMode="decimal"
              placeholder="$0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium">Date</span>
            <input
              type="date"
              className="ez-input mt-2"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium">Load (optional)</span>
            <select
              className="ez-input mt-2"
              value={loadId}
              onChange={(e) => setLoadId(e.target.value)}
              disabled={loadsQuery.isPending}
            >
              <option value="">Not tied to a load</option>
              {(loadsQuery.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.reference ?? l.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>

          {loadsQuery.isError ? <ErrorBox error={loadsQuery.error} /> : null}
          {save.isError ? <ErrorBox error={save.error} /> : null}

          <button
            type="submit"
            disabled={!valid || save.isPending}
            className="ez-btn-amber w-full disabled:opacity-40"
          >
            {save.isPending ? "Saving…" : "Save expense"}
          </button>
        </form>
      </div>
    </div>
  );
}
