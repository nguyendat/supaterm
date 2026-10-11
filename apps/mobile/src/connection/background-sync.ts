import { BackgroundSync, BackgroundSyncTask } from "@supacode/client-runtime/background-sync";
import * as Layer from "effect/Layer";

import * as Runtime from "../lib/runtime";
import * as ConnectionStorage from "./storage";

/**
 * Entry point for native background work such as BGAppRefreshTask or
 * WorkManager. It needs no React tree or navigation and stays out of the
 * connection runtime, so it opens no socket and never reports this device as a
 * foreground client. It shares the app's database, HTTP client, and relay
 * gateway with any running foreground session.
 */
export const runMobileBackgroundSync = BackgroundSyncTask.makeTaskRunner(
  BackgroundSync.layer.pipe(Layer.provide(ConnectionStorage.layer), Layer.provide(Runtime.layer)),
);
