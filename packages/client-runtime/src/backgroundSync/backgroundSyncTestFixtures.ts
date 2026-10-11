import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionRoute,
} from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import { BearerConnectionTarget } from "../connection/model.ts";

export const ENVIRONMENT_ID = EnvironmentId.make("environment-sync");
export const BEARER_TOKEN = "sync-token";

export function bearerRoute(id: string, origin: string): ConnectionRoute {
  const target = new BearerConnectionTarget({
    connectionId: id,
    environmentId: ENVIRONMENT_ID,
    label: "Build Mac",
  });
  return {
    target,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: ENVIRONMENT_ID,
        label: target.label,
        httpBaseUrl: `${origin}/`,
        wsBaseUrl: `${origin.replace("http", "ws")}/`,
      }),
    ),
  };
}

export const LAN_ORIGIN = "http://192.168.1.2:4389";
export const TAILNET_ORIGIN = "http://100.100.1.2:4389";
export const lan = bearerRoute("lan", LAN_ORIGIN);
export const tailnet = bearerRoute("tailnet", TAILNET_ORIGIN);

export const credentialStore = ConnectionCredentialStore.make({
  get: () => Effect.succeedSome(new BearerConnectionCredential({ token: BEARER_TOKEN })),
  put: () => Effect.void,
  remove: () => Effect.void,
});

export function descriptorResponse(environmentId: EnvironmentId = ENVIRONMENT_ID): Response {
  return Response.json({
    environmentId,
    label: "Build Mac",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0-test",
    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    capabilities: { repositoryIdentity: true },
  });
}

export interface RecordedRequest {
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly authorization: string | null;
  aborted: boolean;
}

/** A fake environment server reached through `fetch`, recording every request it sees. */
export function makeFakeFetch(
  handle: (
    request: RecordedRequest,
    signal: AbortSignal | undefined,
  ) => Response | Promise<Response>,
) {
  const requests: Array<RecordedRequest> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      origin: url.origin,
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
      aborted: false,
    };
    requests.push(request);
    init?.signal?.addEventListener("abort", () => {
      request.aborted = true;
    });
    return handle(request, init?.signal ?? undefined);
  };
  return { requests, fetchFn };
}

/** A response that never arrives; the request ends only when its caller aborts it. */
export function pendingUntilAborted(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}
