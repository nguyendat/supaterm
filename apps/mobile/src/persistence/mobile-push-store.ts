import { EnvironmentId } from "@supacode/contracts";
import {
  DEFAULT_PUSH_PREFERENCES,
  PushNotificationData,
  PushEnrollmentData,
  PushPreferences,
  PushRegistration,
  PushSecret,
} from "@supacode/contracts/push";
import { encodeBase64 } from "@supacode/shared/relay/protocol";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as MobileSecureStorage from "./mobile-secure-storage";

export const MobilePushRecord = Schema.Struct({
  environmentId: EnvironmentId,
  revocationToken: PushSecret,
  previousRevocationToken: Schema.optionalKey(PushSecret),
  preferences: PushPreferences,
  registration: Schema.NullOr(PushRegistration),
  revocationPending: Schema.optionalKey(Schema.Boolean),
});
export type MobilePushRecord = typeof MobilePushRecord.Type;
const TapState = Schema.Struct({
  pending: Schema.NullOr(PushNotificationData),
  handled: Schema.NullOr(Schema.String),
});
const recordCodec = Schema.fromJsonString(MobilePushRecord);
const tapCodec = Schema.fromJsonString(TapState);
const recordKey = (id: EnvironmentId) =>
  `supacode.push.${encodeBase64(new TextEncoder().encode(id))}`;
const TAP_KEY = "supacode.push.tap";
const CHALLENGE_KEY = "supacode.push.challenges";
const challengeCodec = Schema.fromJsonString(Schema.Array(PushEnrollmentData));
const tapKey = (tap: typeof PushNotificationData.Type) =>
  `${tap.recipientId}:${tap.generation}:${tap.notificationId}`;

export class MobilePushStoreError extends Schema.TaggedError<MobilePushStoreError>()(
  "MobilePushStoreError",
  {
    operation: Schema.Literals(["read", "write", "create", "tap"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not save notification preferences on this device.";
  }
}

export class MobilePushStore extends Context.Service<
  MobilePushStore,
  {
    readonly load: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<MobilePushRecord | null, MobilePushStoreError>;
    readonly ensure: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<MobilePushRecord, MobilePushStoreError>;
    readonly save: (record: MobilePushRecord) => Effect.Effect<void, MobilePushStoreError>;
    readonly remove: (environmentId: EnvironmentId) => Effect.Effect<void, MobilePushStoreError>;
    readonly enrollmentChallenges: (
      recipientId: string,
    ) => Effect.Effect<ReadonlyArray<typeof PushEnrollmentData.Type>, MobilePushStoreError>;
    readonly saveChallenge: (
      challenge: typeof PushEnrollmentData.Type,
    ) => Effect.Effect<void, MobilePushStoreError>;
    readonly pending: Effect.Effect<typeof PushNotificationData.Type | null, MobilePushStoreError>;
    readonly enqueueTap: (
      tap: typeof PushNotificationData.Type,
    ) => Effect.Effect<typeof PushNotificationData.Type | null, MobilePushStoreError>;
    readonly finishTap: (
      tap: typeof PushNotificationData.Type,
    ) => Effect.Effect<void, MobilePushStoreError>;
  }
>()("supacode/mobile/MobilePushStore") {}

const make = Effect.gen(function* () {
  const storage = yield* MobileSecureStorage.MobileSecureStorage;
  const crypto = yield* Crypto.Crypto;
  const lane = yield* Semaphore.make(1);
  const error = (operation: MobilePushStoreError["operation"]) =>
    Effect.mapError((cause: unknown) => new MobilePushStoreError({ operation, cause }));
  const load = Effect.fn("MobilePushStore.load")(function* (environmentId: EnvironmentId) {
    const value = yield* storage.getItem(recordKey(environmentId));
    return value === null ? null : yield* Schema.decodeEffect(recordCodec)(value);
  }, error("read"));
  const save = Effect.fn("MobilePushStore.save")(function* (record: MobilePushRecord) {
    const value = yield* Schema.encodeEffect(recordCodec)(record);
    yield* storage.setItem(recordKey(record.environmentId), value);
  }, error("write"));
  const ensure = (environmentId: EnvironmentId) =>
    lane
      .withPermit(
        Effect.gen(function* () {
          const existing = yield* load(environmentId);
          if (existing !== null) return existing;
          const record: MobilePushRecord = {
            environmentId,
            revocationToken: encodeBase64(yield* crypto.randomBytes(32)),
            preferences: DEFAULT_PUSH_PREFERENCES,
            registration: null,
          };
          yield* save(record);
          return record;
        }),
      )
      .pipe(error("create"));
  const readTap = Effect.gen(function* () {
    const value = yield* storage.getItem(TAP_KEY);
    return value === null
      ? { pending: null, handled: null }
      : yield* Schema.decodeEffect(tapCodec)(value);
  });
  const writeTap = (value: typeof TapState.Type) =>
    Schema.encodeEffect(tapCodec)(value).pipe(
      Effect.flatMap((encoded) => storage.setItem(TAP_KEY, encoded)),
    );
  const enqueueTap = (tap: typeof PushNotificationData.Type) =>
    lane
      .withPermit(
        Effect.gen(function* () {
          const state = yield* readTap;
          if (state.handled === tapKey(tap)) return state.pending;
          yield* writeTap({ pending: tap, handled: state.handled });
          return tap;
        }),
      )
      .pipe(error("tap"));
  const finishTap = (tap: typeof PushNotificationData.Type) =>
    lane
      .withPermit(
        Effect.gen(function* () {
          const state = yield* readTap;
          if (state.pending !== null && tapKey(state.pending) === tapKey(tap))
            yield* writeTap({ pending: null, handled: tapKey(tap) });
        }),
      )
      .pipe(error("tap"));
  const challenges = Effect.gen(function* () {
    const value = yield* storage.getItem(CHALLENGE_KEY);
    return value === null ? [] : yield* Schema.decodeEffect(challengeCodec)(value);
  });
  const saveChallenge = (challenge: typeof PushEnrollmentData.Type) =>
    lane
      .withPermit(
        Effect.gen(function* () {
          const prior = yield* challenges;
          const current = prior.filter((entry) => entry.recipientId === challenge.recipientId);
          if (current.some((entry) => entry.generation > challenge.generation)) return;
          const candidates = [
            ...current.filter(
              (entry) =>
                entry.generation === challenge.generation &&
                entry.challenge !== challenge.challenge,
            ),
            challenge,
          ].slice(-4);
          const values = [
            ...prior.filter((entry) => entry.recipientId !== challenge.recipientId),
            ...candidates,
          ].slice(-128);
          const encoded = yield* Schema.encodeEffect(challengeCodec)(values);
          yield* storage.setItem(CHALLENGE_KEY, encoded);
        }),
      )
      .pipe(error("write"));
  return MobilePushStore.of({
    load,
    ensure,
    save,
    remove: (environmentId) => storage.removeItem(recordKey(environmentId)).pipe(error("write")),
    enrollmentChallenges: (recipientId) =>
      challenges.pipe(
        Effect.map((values) => values.filter((value) => value.recipientId === recipientId)),
        error("read"),
      ),
    saveChallenge,
    pending: readTap.pipe(
      Effect.map((state) => state.pending),
      error("tap"),
    ),
    enqueueTap,
    finishTap,
  });
});

export const layer = Layer.effect(MobilePushStore, make);
