import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Crypto from "effect/Crypto";
import { EnvironmentId } from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));
import * as MobileSecureStorage from "./mobile-secure-storage";
import * as MobilePushStore from "./mobile-push-store";

const tap = {
  version: 1 as const,
  recipientId: "4fdb0315-91e9-4f80-8436-d863fe5d402f",
  generation: 1,
  notificationId: "c7ebad8a-516d-46a3-81e7-57b0a9d196e6",
};
function storageLayer() {
  const values = new Map<string, string>();
  return Layer.succeed(MobileSecureStorage.MobileSecureStorage, {
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  });
}
const storeLayer = (storage: ReturnType<typeof storageLayer>) =>
  MobilePushStore.layer.pipe(
    Layer.provide(storage),
    Layer.provide(
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(NodeCrypto.randomBytes(size)),
          digest: (algorithm, data) =>
            Effect.sync(
              () =>
                new Uint8Array(
                  NodeCrypto.createHash(algorithm.replace("-", "").toLowerCase())
                    .update(data)
                    .digest(),
                ),
            ),
        }),
      ),
    ),
  );

it.effect("keeps device revocation secrets stable and isolated per environment", () =>
  Effect.gen(function* () {
    const store = yield* MobilePushStore.MobilePushStore;
    const first = yield* store.ensure(EnvironmentId.make("first"));
    const again = yield* store.ensure(EnvironmentId.make("first"));
    const other = yield* store.ensure(EnvironmentId.make("other"));
    assert.strictEqual(first.revocationToken, again.revocationToken);
    assert.notStrictEqual(first.revocationToken, other.revocationToken);
    yield* store.save({ ...first, preferences: { ...first.preferences, completion: false } });
    assert.strictEqual((yield* store.load(first.environmentId))?.preferences.completion, false);
    yield* store.remove(first.environmentId);
    assert.isNull(yield* store.load(first.environmentId));
    assert.isNotNull(yield* store.load(other.environmentId));
  }).pipe(Effect.provide(storeLayer(storageLayer()))),
);

it.effect("restores an unhandled tap after restart and ignores duplicate handled responses", () =>
  Effect.gen(function* () {
    const storage = storageLayer();
    const run = <A, E>(effect: Effect.Effect<A, E, MobilePushStore.MobilePushStore>) =>
      effect.pipe(Effect.provide(storeLayer(storage)));
    const enqueue = MobilePushStore.MobilePushStore.pipe(
      Effect.flatMap((store) => store.enqueueTap(tap)),
    );
    assert.deepStrictEqual(yield* run(enqueue), tap);
    assert.deepStrictEqual(
      yield* run(MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.pending))),
      tap,
    );
    yield* run(
      MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.finishTap(tap))),
    );
    assert.isNull(yield* run(enqueue));
    const next = { ...tap, notificationId: "e6bb9ef7-82f3-473a-b66b-7344e9405a82" };
    yield* run(
      MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.enqueueTap(next))),
    );
    yield* run(
      MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.finishTap(tap))),
    );
    assert.deepStrictEqual(
      yield* run(MobilePushStore.MobilePushStore.pipe(Effect.flatMap((store) => store.pending))),
      next,
    );
  }),
);

it.effect("persists enrollment challenges and replaces obsolete generations", () =>
  Effect.gen(function* () {
    const store = yield* MobilePushStore.MobilePushStore;
    const first = {
      version: 1 as const,
      recipientId: tap.recipientId,
      generation: 1,
      challenge: "a".repeat(43),
    };
    yield* store.saveChallenge(first);
    assert.deepStrictEqual(yield* store.enrollmentChallenges(first.recipientId), [first]);
    const second = { ...first, generation: 2, challenge: "b".repeat(43) };
    yield* store.saveChallenge(second);
    yield* store.saveChallenge(first);
    assert.deepStrictEqual(yield* store.enrollmentChallenges(first.recipientId), [second]);
    const rotated = { ...second, challenge: "c".repeat(43) };
    yield* store.saveChallenge(rotated);
    yield* store.saveChallenge(second);
    assert.deepStrictEqual(yield* store.enrollmentChallenges(first.recipientId), [rotated, second]);
  }).pipe(Effect.provide(storeLayer(storageLayer()))),
);
