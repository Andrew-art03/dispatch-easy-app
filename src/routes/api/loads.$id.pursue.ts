import { createFileRoute } from "@tanstack/react-router";

/** STUB. */
export const Route = createFileRoute("/api/loads/$id/pursue")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        return Response.json({
          ok: true,
          load_id: params.id,
          message: "Pursue was sent. The dispatch service takes it from here.",
        });
      },
    },
  },
});
