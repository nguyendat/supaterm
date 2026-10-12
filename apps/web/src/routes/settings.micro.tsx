import { createFileRoute } from "@tanstack/react-router";
import { MicroSettings } from "../components/settings/MicroSettings";

export const Route = createFileRoute("/settings/micro")({ component: MicroSettings });
