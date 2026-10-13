import {
  PushNotificationError,
  PushDeliveryPayload,
  PushPreferences,
  PushPreviewKey,
  PushPreviewContent,
} from "@supacode/contracts/push";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PushGateway from "./PushGateway.ts";
import * as PushOutbox from "./PushOutbox.ts";
import * as PushPreview from "./PushPreview.ts";

const decodePreferences = Schema.decodeEffect(Schema.fromJsonString(PushPreferences));
const decodePreviewKey = Schema.decodeEffect(Schema.fromJsonString(PushPreviewKey));
const decodePreviewContent = Schema.decodeEffect(Schema.fromJsonString(PushPreviewContent));
const decodePayload = Schema.decodeEffect(Schema.fromJsonString(PushDeliveryPayload));

export class PushDeliveryWorker extends Context.Service<
  PushDeliveryWorker,
  { readonly drain: Effect.Effect<void, PushNotificationError> }
>()("supacode/notifications/PushDeliveryWorker") {}

const make = Effect.gen(function* () {
  const outbox = yield* PushOutbox.PushOutbox;
  const gateway = yield* PushGateway.PushGateway;
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const preview = yield* PushPreview.PushPreview;
  const lane = yield* Semaphore.make(1);

  const deliver = Effect.fn("PushDeliveryWorker.deliver")(function* (
    delivery: PushOutbox.PendingPushDelivery,
  ) {
    const configuration = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new PushNotificationError({ operation: "deliver", reason: "storage", cause }),
      ),
    );
    if (configuration.pushGatewayUrl !== delivery.gateway_url)
      return yield* outbox.settle(delivery, "cancelled");
    if (!(yield* outbox.eligible(delivery))) return yield* outbox.settle(delivery, "cancelled");
    let encoded = delivery.payload_json;
    if (encoded === null) {
      const metadata = {
        version: 1,
        recipientId: delivery.recipient_id,
        generation: delivery.generation,
        notificationId: delivery.notification_id,
        createdAt: delivery.created_at,
        expiresAt: delivery.expires_at,
      } as const;
      const encrypted = yield* Effect.gen(function* () {
        const preferences = yield* decodePreferences(delivery.preferences_json);
        if (
          !preferences.previews ||
          delivery.preview_json === null ||
          delivery.preview_key_json === null
        )
          return undefined;
        const key = yield* decodePreviewKey(delivery.preview_key_json);
        const content = yield* decodePreviewContent(delivery.preview_json);
        return yield* preview.encrypt(key, metadata, content);
      }).pipe(Effect.orElseSucceed(() => undefined));
      encoded = yield* outbox.prepare(delivery, {
        ...metadata,
        ...(encrypted === undefined ? {} : { preview: encrypted }),
      });
    }
    if (encoded === null) return;
    if (!(yield* outbox.eligible({ ...delivery, payload_json: encoded })))
      return yield* outbox.settle(delivery, "cancelled");
    const payload = yield* decodePayload(encoded).pipe(
      Effect.mapError(
        (cause) => new PushNotificationError({ operation: "deliver", reason: "storage", cause }),
      ),
    );
    const result = yield* gateway
      .send(delivery.gateway_url, payload)
      .pipe(Effect.catchTags({ PushGatewayRequestError: () => Effect.succeed(null) }));
    if (result === null) return yield* outbox.settle(delivery, "retry");
    if (result.invalidToken === true) {
      yield* sql`
        UPDATE push_registrations SET status = 'revoked', foreground_until = 0
        WHERE recipient_id = ${delivery.recipient_id} AND generation = ${delivery.generation}
      `.pipe(
        Effect.mapError(
          (cause) => new PushNotificationError({ operation: "deliver", reason: "storage", cause }),
        ),
      );
    }
    const status =
      result.accepted === true ? "accepted" : result.retryable === true ? "retry" : "failed";
    yield* outbox.settle(delivery, status);
  });

  const drain = lane.withPermit(
    Effect.gen(function* () {
      for (;;) {
        const delivery = yield* outbox.claim;
        if (delivery === null) return;
        yield* deliver(delivery);
      }
    }),
  );

  yield* drain.pipe(
    Effect.catchTags({
      PushNotificationError: () =>
        Effect.logWarning("Notification delivery worker could not read its queue."),
    }),
    Effect.andThen(
      outbox.nextDelay.pipe(
        Effect.orElseSucceed(() => 30_000),
        Effect.flatMap((delay) => outbox.awaitAvailable.pipe(Effect.timeoutOption(delay))),
      ),
    ),
    Effect.forever,
    forkParked,
  );
  return PushDeliveryWorker.of({ drain });
});

export const layer = Layer.effect(PushDeliveryWorker, make);
