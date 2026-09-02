import { createFileRoute } from "@tanstack/react-router";

/** STUB. */
export const Route = createFileRoute("/api/loads/$id/skip")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        return Response.json({
          ok: true,
          load_id: params.id,
          message: "Skip was sent. This load won't be worked.",
        });
      },
    },
  },
});
