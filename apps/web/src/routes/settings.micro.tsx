import { createFileRoute, redirect } from "@tanstack/react-router";
import { MicroSettings } from "~/components/settings/MicroSettings";
import { isElectron } from "../env";

export const Route = createFileRoute("/settings/micro")({
  beforeLoad: () => {
    if (!isElectron) throw redirect({ to: "/settings/general" });
  },
  component: MicroSettings,
});
