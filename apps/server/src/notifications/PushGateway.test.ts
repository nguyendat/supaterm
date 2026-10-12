import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TestClock } from "effect/testing";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PushGateway from "./PushGateway.ts";
const secrets = Layer.succeed(ServerSecretStore.ServerSecretStore, {
  get: () => Effect.succeed(Option.none()),
  set: () => Effect.void,
  create: () => Effect.void,
  getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(1)),
  remove: () => Effect.void,
});
const payload = {
  version: 1 as const,
  recipientId: "4fdb0315-91e9-4f80-8436-d863fe5d402f",
  generation: 1,
  notificationId: "c7ebad8a-516d-46a3-81e7-57b0a9d196e6",
  createdAt: 0,
  expiresAt: 100000,
};
const gatewayLayer = (client: HttpClient.HttpClient) =>
  PushGateway.layer.pipe(
    Layer.provide(secrets),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );

it.effect("bounds the full HTTP operation when receipt headers arrive but the body stalls", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const bodyStarted = yield* Deferred.make<void>();
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                pull() {
                  Deferred.doneUnsafe(bodyStarted, Effect.void);
                },
              }),
              { status: 202 },
            ),
          ),
        ),
      );
      const fiber = yield* PushGateway.PushGateway.pipe(
        Effect.flatMap((gateway) => gateway.send("https://push.supacode.sh", payload)),
        Effect.result,
        Effect.provide(gatewayLayer(client)),
        Effect.forkChild,
      );
      yield* Deferred.await(bodyStarted);
      yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure.reason, "unavailable");
    }),
  ),
);

it.effect("rejects receipts exceeding the bounded body size", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(" ".repeat(4097), { status: 202 })),
      ),
    );
    const result = yield* PushGateway.PushGateway.pipe(
      Effect.flatMap((gateway) => gateway.send("https://push.supacode.sh", payload)),
      Effect.result,
      Effect.provide(gatewayLayer(client)),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect(
  "treats a missing recipient as successfully revoked and keeps delivery responses exact",
  () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(request.url.endsWith("/revoke") ? {} : { accepted: true }, {
              status: request.url.endsWith("/revoke") ? 404 : 202,
            }),
          ),
        ),
      );
      yield* PushGateway.PushGateway.pipe(
        Effect.flatMap((gateway) => gateway.revoke("https://push.supacode.sh", payload)),
        Effect.provide(gatewayLayer(client)),
      );
      const result = yield* PushGateway.PushGateway.pipe(
        Effect.flatMap((gateway) => gateway.send("https://push.supacode.sh", payload)),
        Effect.result,
        Effect.provide(gatewayLayer(client)),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
);
