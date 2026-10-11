import { EnvironmentId, OrchestrationV2ShellSnapshot } from "@supacode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import { mapRemoteEnvironmentError } from "../connection/errors.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { fetchEnvironmentShellSnapshot } from "../state/shellSnapshotHttp.ts";
import { v2ShellSnapshot } from "../state/orchestrationV2TestFixtures.ts";
import {
  BEARER_TOKEN,
  LAN_ORIGIN,
  TAILNET_ORIGIN,
  credentialStore,
  descriptorResponse,
  lan,
  makeFakeFetch,
  pendingUntilAborted,
  tailnet,
  type RecordedRequest,
} from "./backgroundSyncTestFixtures.ts";
import { openHttpRoute } from "./httpRoute.ts";

const SHELL_JSON = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ShellSnapshot))({
  ...v2ShellSnapshot,
  snapshotSequence: 7,
});
const entry = { ...lan, enabled: true, alternateRoutes: [tailnet] };

const readShell = (endpoint: Parameters<Parameters<typeof openHttpRoute>[1]>[0]) =>
  fetchEnvironmentShellSnapshot({ prepared: endpoint }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );

function openWith(
  handle: (
    request: RecordedRequest,
    signal: AbortSignal | undefined,
  ) => Response | Promise<Response>,
) {
  const server = makeFakeFetch(handle);
  const opened = openHttpRoute(entry, readShell).pipe(
    Effect.scoped,
    Effect.provide(layerRemoteHttpClient(server.fetchFn)),
    Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
  );
  return { requests: server.requests, opened };
}

const credentialedOrigins = (requests: ReadonlyArray<RecordedRequest>) =>
  new Set(
    requests.flatMap(({ authorization, origin }) => (authorization === null ? [] : [origin])),
  );

describe("openHttpRoute", () => {
  it.effect("reads through a reachable fallback when the saved first route stays silent", () =>
    Effect.gen(function* () {
      const { requests, opened } = openWith((request, signal) => {
        if (request.origin === LAN_ORIGIN) return pendingUntilAborted(signal);
        return request.path.endsWith("/environment")
          ? descriptorResponse()
          : Response.json(SHELL_JSON);
      });
      const fiber = yield* Effect.forkChild(opened);
      yield* TestClock.adjust("300 millis");
      const result = yield* Fiber.join(fiber);

      expect(result.route).toBe(entry.alternateRoutes[0]);
      expect(result.value.snapshotSequence).toBe(7);
      expect(result.endpoint).toEqual({
        httpBaseUrl: `${TAILNET_ORIGIN}/`,
        httpAuthorization: { _tag: "Bearer", token: BEARER_TOKEN },
      });
      expect(credentialedOrigins(requests)).toEqual(new Set([TAILNET_ORIGIN]));
      expect(requests.find((request) => request.origin === LAN_ORIGIN)?.aborted).toBe(true);
      expect(requests.every((request) => request.method === "GET")).toBe(true);
      expect(requests.some((request) => request.path.includes("websocket-ticket"))).toBe(false);
    }),
  );

  it.effect("moves on when a reachable route rejects the credential", () =>
    Effect.gen(function* () {
      const { requests, opened } = openWith((request) => {
        if (request.path.endsWith("/environment")) return descriptorResponse();
        return request.origin === LAN_ORIGIN
          ? new Response("Unauthorized", { status: 401 })
          : Response.json(SHELL_JSON);
      });
      const result = yield* opened;

      expect(result.route.target).toEqual(tailnet.target);
      expect(
        requests
          .filter((request) => request.path.endsWith("/shell"))
          .map((request) => request.origin),
      ).toEqual([LAN_ORIGIN, TAILNET_ORIGIN]);
    }),
  );

  it.effect("never sends the credential to an address that answers as another environment", () =>
    Effect.gen(function* () {
      const { requests, opened } = openWith((request) => {
        if (request.origin === LAN_ORIGIN) {
          return descriptorResponse(EnvironmentId.make("someone-elses-mac"));
        }
        return request.path.endsWith("/environment")
          ? descriptorResponse()
          : new Response("Unavailable", { status: 503 });
      });
      const error = yield* Effect.flip(opened);

      expect(error._tag).toBe("ConnectionTransientError");
      expect(credentialedOrigins(requests)).toEqual(new Set([TAILNET_ORIGIN]));
      expect(
        requests.filter((request) => request.origin === LAN_ORIGIN).map(({ path }) => path),
      ).toEqual(["/.well-known/supacode/environment", "/.well-known/supacode/environment"]);
    }),
  );
});
