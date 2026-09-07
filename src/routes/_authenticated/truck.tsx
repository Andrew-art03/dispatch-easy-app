import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/truck")({
  beforeLoad: () => {
    throw redirect({ to: "/settings", replace: true });
  },
  component: () => null,
});
