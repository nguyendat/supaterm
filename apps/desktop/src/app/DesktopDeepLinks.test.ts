// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Hosted handoff test uses a real localhost listener without an OpenAI account.
import * as NodeHttp from "node:http";
import { codexAuthHandoffUrl, readCodexAuthDelivery } from "@supacode/shared/codexAuthHandoff";
import { EnvironmentId, ProviderInstanceId } from "@supacode/contracts";
import * as HostProcess from "@supacode/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodePath from "@effect/platform-node/NodePath";
import { vi } from "vite-plus/test";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopDeepLinks from "./DesktopDeepLinks.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const defaultShell: ElectronShell.ElectronShell["Service"] = {
  openExternal: () => Effect.succeed(true),
  openSystemSettings: () => Effect.succeed(false),
  copyText: () => Effect.void,
};

const makeDesktopDeepLinksLayer = ({
  platform = "linux",
  isDevelopment = true,
  hasSingleInstanceLock = true,
  events = [],
  shell = defaultShell,
}: {
  readonly platform?: NodeJS.Platform;
  readonly isDevelopment?: boolean;
  readonly hasSingleInstanceLock?: boolean;
  readonly events?: string[];
  readonly shell?: ElectronShell.ElectronShell["Service"];
} = {}) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    platform,
    stateDir: "/tmp/supacode-state",
    isDevelopment,
    appDataDirectory: "/tmp/app-data",
    userDataDirName: isDevelopment ? "supacode-dev" : "supacode",
    legacyUserDataDirName: isDevelopment ? "Supacode (Dev)" : "Supacode (Alpha)",
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
    requestSingleInstanceLock: Effect.sync(() => {
      events.push("requestSingleInstanceLock");
      return hasSingleInstanceLock;
    }),
    setAsDefaultProtocolClient: (protocol: string) =>
      Effect.sync(() => {
        events.push(`setAsDefaultProtocolClient:${protocol}`);
        return true;
      }),
    quit: Effect.sync(() => {
      events.push("quit");
    }),
  } as unknown as ElectronApp.ElectronApp["Service"];

  return DesktopDeepLinks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        Layer.succeed(ElectronShell.ElectronShell, shell),
        FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
        NodePath.layerPosix,
      ),
    ),
  );
};

const makeListenerApp = (listeners: Map<string, (...args: unknown[]) => void>) =>
  ({
    whenReady: Effect.void,
    on: (name: string, listener: (...args: unknown[]) => void) =>
      Effect.sync(() => {
        listeners.set(name, listener);
      }),
  }) as unknown as ElectronApp.ElectronApp["Service"];

describe("DesktopDeepLinks", () => {
  it.effect("sets userData before acquiring the single-instance lock", () => {
    const events: string[] = [];

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(makeDesktopDeepLinksLayer({ events })));

      assert.deepEqual(events, [
        "setPath:userData:/tmp/app-data/supacode-dev",
        "requestSingleInstanceLock",
        "setAsDefaultProtocolClient:supacode-dev",
      ]);
    });
  });

  it.effect("registers the protocol client without the single-instance lock on macOS", () => {
    const events: string[] = [];

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Layer.build(
          makeDesktopDeepLinksLayer({
            platform: "darwin",
            isDevelopment: false,
            hasSingleInstanceLock: false,
            events,
          }),
        ),
      );

      assert.deepEqual(events, [
        "setPath:userData:/tmp/app-data/supacode-v2",
        "setAsDefaultProtocolClient:supacode",
      ]);
    });
  });

  it.effect("quits and interrupts startup in a secondary instance", () => {
    const events: string[] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();

    return Effect.gen(function* () {
      const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
      const exit = yield* Effect.exit(Effect.scoped(deepLinks.configure));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.deepEqual(events, [
        "setPath:userData:/tmp/app-data/supacode-dev",
        "requestSingleInstanceLock",
        "quit",
      ]);
      assert.deepEqual([...listeners.keys()], []);
    }).pipe(
      Effect.provide(makeDesktopDeepLinksLayer({ hasSingleInstanceLock: false, events })),
      Effect.provideService(ElectronApp.ElectronApp, makeListenerApp(listeners)),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
    );
  });

  it.effect("registers the open-url and second-instance handlers in the primary instance", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();

    return Effect.gen(function* () {
      const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
      const exit = yield* Effect.exit(Effect.scoped(deepLinks.configure));

      assert.isTrue(Exit.isSuccess(exit));
      assert.deepEqual([...listeners.keys()], ["open-url", "second-instance"]);
    }).pipe(
      Effect.provide(makeDesktopDeepLinksLayer()),
      Effect.provideService(ElectronApp.ElectronApp, makeListenerApp(listeners)),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
    );
  });

  it.effect("reveals the running desktop on a plain second launch", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const revealed = Promise.withResolvers<unknown>();
    const window = { loadURL: vi.fn(async (_url: string) => undefined) };
    const electronWindow = {
      currentMainOrFirst: Effect.succeedSome(window),
      reveal: (target: unknown) => Effect.sync(() => revealed.resolve(target)),
    } as unknown as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
      yield* deepLinks.configure;
      listeners.get("second-instance")!({}, ["supacode", "--some-flag"]);

      assert.strictEqual(yield* Effect.promise(() => revealed.promise), window);
      assert.equal(window.loadURL.mock.calls.length, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(makeDesktopDeepLinksLayer()),
      Effect.provideService(ElectronApp.ElectronApp, makeListenerApp(listeners)),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });

  it.effect("provider auth deep links navigate and reveal the running desktop", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const revealed = Promise.withResolvers<void>();
    const loadURL = vi.fn(async (_url: string) => undefined);
    const window = { loadURL };
    const electronWindow = {
      currentMainOrFirst: Effect.succeedSome(window),
      reveal: () => Effect.sync(() => revealed.resolve()),
    } as unknown as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
      yield* deepLinks.configure;
      const event = { preventDefault: vi.fn() };
      listeners.get("open-url")!(event, "supacode-dev://app/auth/callback?code=unrelated-code");
      listeners.get("open-url")!(event, "supacode://app/welcome");
      assert.equal(loadURL.mock.calls.length, 0);
      assert.equal(event.preventDefault.mock.calls.length, 0);
      listeners.get("second-instance")!({}, [
        "supacode",
        "supacode-dev://app/settings/providers?instanceId=work&code=never-forward",
      ]);
      yield* Effect.promise(() => revealed.promise);
      assert.deepEqual(loadURL.mock.calls, [
        ["supacode-dev://app/settings/providers?instanceId=work"],
      ]);
      listeners.get("open-url")!(event, "supacode-dev://app/welcome#agents:machine-id");
      assert.equal(event.preventDefault.mock.calls.length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(makeDesktopDeepLinksLayer()),
      Effect.provideService(ElectronApp.ElectronApp, makeListenerApp(listeners)),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });

  it.effect.each(["startup", "open-url"] as const)(
    "receives hosted web sign-in through the desktop %s handler",
    (entry) =>
      Effect.gen(function* () {
        const port = yield* Effect.promise(async () => {
          const server = NodeHttp.createServer();
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("address");
          await new Promise<void>((resolve) => server.close(() => resolve()));
          return address.port;
        });
        const authorize = new URL("https://auth.openai.com/api/accounts/authorize");
        authorize.search = new URLSearchParams({
          client_id: "dynamic_agent_client",
          response_type: "code",
          redirect_uri: `http://127.0.0.1:${port}/auth/callback`,
          state: "a".repeat(43),
          code_challenge_method: "S256",
          code_challenge: "b".repeat(43),
        }).toString();
        const request = {
          authorizationUrl: authorize.toString(),
          returnUrl: "https://app.next.supacode.sh/welcome#agents:remote-one",
          environmentId: EnvironmentId.make("remote-one"),
          instanceId: ProviderInstanceId.make("work"),
          flowId: "flow-one",
        };
        const link = codexAuthHandoffUrl(request, true);
        const delivered = Promise.withResolvers<string>();
        const shell = ElectronShell.ElectronShell.of({
          openExternal: (value) =>
            Effect.promise(async () => {
              const url = new URL(String(value));
              const callback = new URL(url.searchParams.get("redirect_uri")!);
              callback.search = new URLSearchParams({
                state: url.searchParams.get("state")!,
                code: "test-code",
                client_id: "oaiapp_test",
              }).toString();
              const response = await fetch(callback, { redirect: "manual" });
              delivered.resolve(response.headers.get("location")!);
              return true;
            }),
          openSystemSettings: () => Effect.succeed(false),
          copyText: () => Effect.void,
        });
        const listeners = new Map<string, (...args: unknown[]) => void>();
        yield* Effect.gen(function* () {
          const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
          yield* deepLinks.configure;
          if (entry === "open-url") {
            const event = { preventDefault: vi.fn() };
            listeners.get("open-url")!(event, link);
            assert.strictEqual(event.preventDefault.mock.calls.length, 1);
          }
          const delivery = readCodexAuthDelivery(yield* Effect.promise(() => delivered.promise));
          assert.strictEqual(delivery?.environmentId, request.environmentId);
          assert.strictEqual(delivery?.instanceId, request.instanceId);
          assert.strictEqual(delivery?.flowId, request.flowId);
          assert.strictEqual(delivery?.returnUrl, request.returnUrl);
        }).pipe(
          Effect.provide(makeDesktopDeepLinksLayer({ shell })),
          Effect.provideService(
            HostProcess.Arguments,
            entry === "startup" ? ["supacode", link] : ["supacode"],
          ),
          Effect.provideService(ElectronApp.ElectronApp, makeListenerApp(listeners)),
          Effect.provideService(
            ElectronWindow.ElectronWindow,
            {} as ElectronWindow.ElectronWindow["Service"],
          ),
        );
      }).pipe(Effect.scoped),
  );
});
