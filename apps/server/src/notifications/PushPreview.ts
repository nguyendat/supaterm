import { ed25519 } from "@noble/curves/ed25519.js";
import {
  PushNotificationError,
  type PushDeliveryMetadata,
  type PushPreviewKey,
  type PushPreviewContent,
  type PushPreviewEnvelope,
} from "@supaterm/contracts/push";
import { encodeBase64 } from "@supaterm/shared/relay/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { encryptPushPreview } from "./pushPreviewEnvelope.ts";

export class PushPreview extends Context.Service<
  PushPreview,
  {
    readonly hostSigningKey: Effect.Effect<string, PushNotificationError>;
    readonly encrypt: (
      key: PushPreviewKey,
      metadata: PushDeliveryMetadata,
      content: PushPreviewContent,
    ) => Effect.Effect<PushPreviewEnvelope, PushNotificationError>;
  }
>()("supaterm/notifications/PushPreview") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const identity = yield* Effect.cached(secrets.getOrCreateRandom("push-identity", 32));
  const mapError = (cause: unknown) =>
    new PushNotificationError({ operation: "deliver", reason: "storage", cause });
  return PushPreview.of({
    hostSigningKey: identity.pipe(
      Effect.map((secret) => encodeBase64(ed25519.getPublicKey(secret))),
      Effect.mapError(mapError),
    ),
    encrypt: Effect.fn("PushPreview.encrypt")(function* (key, metadata, content) {
      const secret = yield* identity;
      return yield* Effect.tryPromise({
        try: () => encryptPushPreview(secret, key, metadata, content),
        catch: mapError,
      });
    }, Effect.mapError(mapError)),
  });
});

export const layer = Layer.effect(PushPreview, make);
