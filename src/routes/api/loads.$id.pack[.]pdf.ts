import { createFileRoute } from "@tanstack/react-router";

/** STUB. Real packet building happens server-side. */
export const Route = createFileRoute("/api/loads/$id/pack.pdf")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        return Response.json({
          ok: true,
          load_id: params.id,
          message: "Packet requested. It will be ready shortly.",
        });
      },
    },
  },
});
