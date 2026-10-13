import {
  AuthOrchestrationReadScope,
  DEVICE_MEDIA_V1_PATH,
  DeviceMediaTarget,
  LOCAL_DEVICE_HOST_ID,
} from "@supacode/contracts";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as DeviceMedia from "./DeviceMedia.ts";

const decodeTarget = Schema.decodeUnknownOption(DeviceMediaTarget);

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url) || request.headers.upgrade?.toLowerCase() !== "websocket")
    return HttpServerResponse.text("Not Found", { status: 404 });
  yield* authenticateMediaRequest(AuthOrchestrationReadScope);
  const target = decodeTarget({
    device: url.value.searchParams.get("device"),
    hostId: url.value.searchParams.get("hostId") ?? LOCAL_DEVICE_HOST_ID,
    ...(url.value.searchParams.has("panel") ? { panel: url.value.searchParams.get("panel") } : {}),
  });
  if (Option.isNone(target)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const media = yield* DeviceMedia.DeviceMedia;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* media.open(target.value);
      delete NodeHttpServerRequest.toIncomingMessage(request).headers["sec-websocket-extensions"];
      const socket = yield* request.upgrade;
      yield* session.run(socket).pipe(Effect.ignore);
      return HttpServerResponse.empty();
    }),
  ).pipe(
    Effect.catchTags({
      DeviceMediaError: (error) =>
        Effect.succeed(
          HttpServerResponse.text("Device media unavailable", {
            status: error.reason === "target" ? 404 : 503,
          }),
        ),
    }),
  );
});

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const media = yield* DeviceMedia.DeviceMedia;
    yield* router.add(
      "GET",
      DEVICE_MEDIA_V1_PATH,
      handler.pipe(Effect.provideService(DeviceMedia.DeviceMedia, media)),
    );
  }),
).pipe(Layer.provide(DeviceMedia.layer));
