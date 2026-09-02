import { createFileRoute } from "@tanstack/react-router";

/**
 * STUB. Real parsing/scoring belongs on the server (never in the client, never
 * an AI call from the browser). This does a plain-text best guess so screen 5
 * can be used end to end.
 */
export const Route = createFileRoute("/api/loads")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          text?: string;
          source?: string;
          storage_path?: string | null;
        };
        const text = body.text ?? "";

        const rate = text.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
        const miles = text.match(/([\d,]{2,5})\s*(?:mi|miles)\b/i);
        const reference = text.match(/(?:ref|reference|load)\s*#?\s*([A-Z0-9-]{4,})/i);
        const cities = [...text.matchAll(/([A-Za-z .'-]{2,}),\s*([A-Z]{2})\b/g)];

        return Response.json({
          source: body.source ?? "paste",
          storage_path: body.storage_path ?? null,
          fields: {
            reference: reference?.[1] ?? "",
            gross_rate: rate?.[1]?.replace(/,/g, "") ?? "",
            loaded_miles: miles?.[1]?.replace(/,/g, "") ?? "",
            origin_city: cities[0]?.[1]?.trim() ?? "",
            origin_state: cities[0]?.[2] ?? "",
            origin_address: cities[0]?.[0]?.trim() ?? "",
            dest_city: cities[1]?.[1]?.trim() ?? "",
            dest_state: cities[1]?.[2] ?? "",
            dest_address: cities[1]?.[0]?.trim() ?? "",
          },
        });
      },
    },
  },
});
