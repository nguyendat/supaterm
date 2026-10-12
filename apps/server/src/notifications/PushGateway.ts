import type {
  PushConfirmInput,
  PushRegisterInput,
  PushRevokeInput,
} from "@supacode/contracts/push";
import { pushRequestHeaders } from "@supacode/shared/pushRequest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const EnrollmentReceipt = Schema.Struct({ status: Schema.Literals(["pending", "active"]) });
const ConfirmationReceipt = Schema.Struct({ status: Schema.Literal("active") });
const RevocationReceipt = Schema.Struct({ status: Schema.Literal("revoked") });
const DeliveryReceipt = Schema.Struct({
  accepted: Schema.Boolean,
  retryable: Schema.Boolean,
  invalidToken: Schema.Boolean,
});
export interface PushDeliveryPayload {
  readonly version: 1;
  readonly recipientId: string;
  readonly generation: number;
  readonly notificationId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}
type EnrollmentPayload = Omit<typeof PushRegisterInput.Type, "deviceId" | "preferences"> &
  Pick<typeof PushRevokeInput.Type, "recipientId" | "generation">;
type ConfirmationPayload = Omit<typeof PushConfirmInput.Type, "deviceId">;
type RevocationPayload = Omit<typeof PushRevokeInput.Type, "deviceId">;

export class PushGatewayRequestError extends Schema.TaggedError<PushGatewayRequestError>()(
  "PushGatewayRequestError",
  {
    reason: Schema.Literals(["unavailable", "rejected"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Could not contact the notification gateway.";
  }
}

type GatewayEffect<A> = Effect.Effect<A, PushGatewayRequestError>;
export class PushGateway extends Context.Service<
  PushGateway,
  {
    readonly enroll: (
      url: string,
      payload: EnrollmentPayload,
    ) => GatewayEffect<typeof EnrollmentReceipt.Type>;
    readonly confirm: (url: string, payload: ConfirmationPayload) => GatewayEffect<void>;
    readonly revoke: (url: string, payload: RevocationPayload) => GatewayEffect<void>;
    readonly send: (
      url: string,
      payload: PushDeliveryPayload,
    ) => GatewayEffect<typeof DeliveryReceipt.Type>;
  }
>()("supacode/notifications/PushGateway") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const identity = yield* Effect.cached(secrets.getOrCreateRandom("push-identity", 32));
  const execute = Effect.fn("PushGateway.execute")(
    function* (
      url: string,
      path: string,
      payload: EnrollmentPayload | ConfirmationPayload | RevocationPayload | PushDeliveryPayload,
    ) {
      const secret = yield* identity;
      const timestamp = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
      const body = yield* encodePayload(payload);
      return yield* HttpClientRequest.post(`${url}${path}`).pipe(
        HttpClientRequest.setHeaders(pushRequestHeaders(secret, path, body, timestamp)),
        HttpClientRequest.bodyText(body, "application/json"),
        client.execute,
      );
    },
    Effect.mapError((cause) => new PushGatewayRequestError({ reason: "unavailable", cause })),
  );
  const decode = <A>(schema: Schema.Codec<A>, response: HttpClientResponse.HttpClientResponse) =>
    Effect.gen(function* () {
      let bytes = 0;
      const chunks = yield* response.stream.pipe(
        Stream.mapEffect((chunk) => {
          bytes += chunk.byteLength;
          return bytes > 4096
            ? Effect.fail(new PushGatewayRequestError({ reason: "unavailable" }))
            : Effect.succeed(chunk);
        }),
        Stream.runCollect,
      );
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
        Buffer.concat(chunks).toString("utf8"),
      );
    }).pipe(
      Effect.mapError((cause) => new PushGatewayRequestError({ reason: "unavailable", cause })),
    );
  const isRequestError = Schema.is(PushGatewayRequestError);
  const bounded = <A>(operation: GatewayEffect<A>): GatewayEffect<A> =>
    operation.pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError((cause) =>
        isRequestError(cause)
          ? cause
          : new PushGatewayRequestError({ reason: "unavailable", cause }),
      ),
    );
  const accepted = (response: HttpClientResponse.HttpClientResponse) =>
    response.status >= 400
      ? Effect.fail(
          new PushGatewayRequestError({
            reason: response.status === 429 || response.status >= 500 ? "unavailable" : "rejected",
          }),
        )
      : Effect.void;
  const registrationRequest = <A>(
    url: string,
    path: string,
    payload: EnrollmentPayload | ConfirmationPayload | RevocationPayload,
    schema: Schema.Codec<A>,
  ) =>
    bounded(
      Effect.gen(function* () {
        const response = yield* execute(url, path, payload);
        yield* accepted(response);
        return yield* decode(schema, response);
      }),
    );
  return PushGateway.of({
    enroll: (url, payload) =>
      registrationRequest(url, "/v1/push/enroll", payload, EnrollmentReceipt),
    confirm: (url, payload) =>
      registrationRequest(url, "/v1/push/confirm", payload, ConfirmationReceipt).pipe(
        Effect.asVoid,
      ),
    revoke: (url, payload) =>
      bounded(
        Effect.gen(function* () {
          const response = yield* execute(url, "/v1/push/revoke", payload);
          if (response.status === 404) return;
          yield* accepted(response);
          yield* decode(RevocationReceipt, response);
        }),
      ),
    send: (url, payload) =>
      bounded(
        Effect.gen(function* () {
          const response = yield* execute(url, "/v1/push/send", payload);
          if (response.status === 429 || response.status >= 500)
            return { accepted: false, retryable: true, invalidToken: false };
          return yield* decode(DeliveryReceipt, response);
        }),
      ),
  });
});
export const layer = Layer.effect(PushGateway, make);
