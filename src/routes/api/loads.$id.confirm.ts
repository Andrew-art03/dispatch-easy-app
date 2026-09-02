import { createFileRoute } from "@tanstack/react-router";

/** STUB. State changes belong here, not in the client. */
export const Route = createFileRoute("/api/loads/$id/confirm")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        return Response.json({
          ok: true,
          load_id: params.id,
          message: "Confirm was sent. Booking is handled by the dispatch service.",
        });
      },
    },
  },
});
