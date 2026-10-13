import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSessionId,
  PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE,
  PreviewStreamHostSetup,
  type AuthEnvironmentScope,
} from "@supacode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { routeLayer } from "./ServerBrowserStream.ts";

const platformLayer = NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer));

const makeAuth = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  error?: EnvironmentAuth.ServerAuthCredentialError,
) => {
  const requests: string[] = [];
  const layer = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
    authenticateWebSocketUpgrade: (request) => {
      requests.push(request.originalUrl);
      return error
        ? Effect.fail(error)
        : Effect.succeed({
            sessionId: AuthSessionId.make("stream-test"),
            subject: "stream-test",
            method: "bearer-access-token",
            scopes,
          });
    },
  });
  return { layer, requests };
};

const mutations = [
  { type: "resize", width: 390, height: 844 },
  { type: "mouse", action: "down", x: 10, y: 10, button: "left", buttons: 1 },
  { type: "key", action: "down", key: "Enter" },
  { type: "text", text: "reader must not type" },
  { type: "wheel", deltaY: 100 },
  { type: "navigate", url: "https://example.com" },
  { type: "history", delta: -1 },
  { type: "reload" },
  { type: "probe", x: 10, y: 10 },
  { type: "takeControl" },
  { type: "releaseControl" },
  { type: "dialog", accept: true },
  { type: "viewport", setting: { _tag: "fill" } },
];

it.effect.each([
  { preview: false, orchestration: false, interactive: true },
  { preview: false, orchestration: true, interactive: true },
  { preview: true, orchestration: false, interactive: true },
  { preview: true, orchestration: true, interactive: true },
  { preview: true, orchestration: false, interactive: false },
])(
  "streams frames and acks while gating page mutations (%s)",
  ({ preview, orchestration, interactive }) =>
    Effect.gen(function* () {
      const canOperate = preview && interactive;
      const scopes = [
        AuthOrchestrationReadScope,
        ...(preview ? [AuthPreviewOperateScope] : []),
        ...(orchestration ? [AuthOrchestrationOperateScope] : []),
      ];
      const auth = makeAuth(scopes);
      const inputs: unknown[] = [];
      const attachments: Parameters<ServerBrowser.ServerBrowser["Service"]["attachViewer"]>[0][] =
        [];
      const acked = Promise.withResolvers<void>();
      const frame = new Uint8Array([255, 216, 255, 217]);
      const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>();
      yield* Queue.offer(output, { _tag: "viewport", width: 1280, height: 800 });
      yield* Queue.offer(output, {
        _tag: "frame",
        data: frame,
        ack: Effect.sync(() => acked.resolve()),
      });
      const browser = ServerBrowser.ServerBrowser.of({
        clearProfile: () => Effect.void,
        reportProfiles: () => Effect.void,
        openDownload: () => Effect.succeedNone,
        answerFileChooser: () => Effect.succeed(false),
        attachViewer: (input) =>
          Effect.sync(() => {
            attachments.push(input);
            return {
              output,
              input: (message) => Effect.sync(() => void inputs.push(message)),
            };
          }),
      });
      const services = yield* Layer.build(
        HttpRouter.serve(
          routeLayer.pipe(
            Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
            Layer.provide(platformLayer),
          ),
          { disableListenLog: true },
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(auth.layer)),
      );
      const server = Context.get(services, HttpServer.HttpServer);
      const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
      const resource = `/api/preview-stream/ws?threadId=thread&tabId=tab&wsTicket=one-use-ticket${interactive ? "" : "&interactive=false"}`;
      const received = Promise.withResolvers<void>();
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => new WebSocket(`${origin}${resource}`)),
        (socket) => Effect.sync(() => socket.close()),
      );
      socket.binaryType = "arraybuffer";
      const viewports: unknown[] = [];
      const frames: Uint8Array[] = [];
      socket.addEventListener("error", () => received.reject(new Error("stream failed")));
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          viewports.push(JSON.parse(event.data));
          return;
        }
        frames.push(new Uint8Array(event.data as ArrayBuffer));
        for (const message of mutations) socket.send(JSON.stringify(message));
        socket.send("malformed input");
        socket.send(JSON.stringify({ type: "ack" }));
        received.resolve();
      });
      yield* Effect.promise(() => received.promise);
      // The ack follows every mutation on the socket, so this is also a barrier
      // proving all preceding inputs were processed, without a timing sleep.
      yield* Effect.promise(() => acked.promise);
      expect(frames).toEqual([frame]);
      expect(viewports).toEqual([{ type: "viewport", width: 1280, height: 800 }]);
      expect(inputs).toEqual(canOperate ? [...mutations, null] : []);
      expect(attachments).toEqual([
        {
          threadId: "thread",
          tabId: "tab",
          maxWidth: 1280,
          maxHeight: 800,
          quality: 70,
          canOperate,
        },
      ]);
      // In particular, a one-use ticket must never be authenticated a second
      // time to discover whether this read session also has operate scope.
      expect(auth.requests).toEqual([resource]);
    }).pipe(Effect.scoped),
);

it.effect.each([
  { scopes: [], error: undefined, status: 403 },
  { scopes: [AuthOrchestrationOperateScope], error: undefined, status: 403 },
  { scopes: [], error: new EnvironmentAuth.ServerAuthMissingCredentialError({}), status: 401 },
])("rejects unauthorized stream connections before attaching a viewer (%s)", (testCase) =>
  Effect.gen(function* () {
    const auth = makeAuth(testCase.scopes, testCase.error);
    let attachments = 0;
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      reportProfiles: () => Effect.void,
      openDownload: () => Effect.succeedNone,
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: () => {
        attachments++;
        return Effect.die("unauthorized viewer must not attach");
      },
    });
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          routeLayer.pipe(
            Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
            Layer.provide(platformLayer),
            Layer.provideMerge(auth.layer),
          ),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(dispose),
    );
    const response = yield* Effect.promise(() =>
      handler.handler(
        new Request("http://supacode.test/api/preview-stream/ws?threadId=thread&tabId=tab", {
          headers: { upgrade: "websocket" },
        }),
      ),
    );
    expect(response.status).toBe(testCase.status);
    expect(attachments).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("serves a tab's download only to an authorized session", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${yield* fs.makeTempDirectoryScoped({ prefix: "supacode-download-" })}/file`;
    yield* fs.writeFileString(path, "report contents");
    const requests: Array<unknown> = [];
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      reportProfiles: () => Effect.void,
      openDownload: (input) =>
        Effect.sync(() => {
          requests.push(input);
          return input.downloadId === "download-1"
            ? Option.some({ path, fileName: "Q3 report.csv" })
            : Option.none();
        }),
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: () => Effect.die("unused"),
    });
    const serve = (scopes: ReadonlyArray<AuthEnvironmentScope>, url: string) =>
      Effect.gen(function* () {
        const handler = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              routeLayer.pipe(
                Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
                Layer.provide(platformLayer),
                Layer.provideMerge(makeAuth(scopes, undefined).layer),
              ),
              { disableLogger: true },
            ),
          ),
          ({ dispose }) => Effect.promise(dispose),
        );
        return yield* Effect.promise(() => handler.handler(new Request(url)));
      });
    const base = "http://supacode.test/api/preview-stream/download?threadId=thread&tabId=tab";
    const denied = yield* serve([], `${base}&id=download-1`);
    expect(denied.status).toBe(403);
    expect(requests).toEqual([]);
    const response = yield* serve([AuthOrchestrationReadScope], `${base}&id=download-1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="Q3 report.csv"',
    );
    expect(yield* Effect.promise(() => response.text())).toBe("report contents");
    const missing = yield* serve([AuthOrchestrationReadScope], `${base}&id=other`);
    expect(missing.status).toBe(404);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("passes uploaded files to the page's open picker and needs operate scope", () =>
  Effect.gen(function* () {
    const answers: Array<{ chooserId: string; files: Array<{ name: string; text: string }> }> = [];
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      reportProfiles: () => Effect.void,
      openDownload: () => Effect.succeedNone,
      answerFileChooser: (input) =>
        Effect.sync(() => {
          answers.push({
            chooserId: input.chooserId,
            files: input.files.map((file) => ({ name: file.name, text: file.buffer.toString() })),
          });
          return input.chooserId === "chooser-1";
        }),
      attachViewer: () => Effect.die("unused"),
    });
    const upload = (scopes: ReadonlyArray<AuthEnvironmentScope>, chooser: string) =>
      Effect.gen(function* () {
        const handler = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              routeLayer.pipe(
                Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
                Layer.provide(platformLayer),
                Layer.provideMerge(makeAuth(scopes, undefined).layer),
              ),
              { disableLogger: true },
            ),
          ),
          ({ dispose }) => Effect.promise(dispose),
        );
        const body = new FormData();
        body.append("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
        return yield* Effect.promise(() =>
          handler.handler(
            new Request(
              `http://supacode.test/api/preview-stream/upload?threadId=thread&tabId=tab&chooser=${chooser}`,
              { method: "POST", body },
            ),
          ),
        );
      });
    expect((yield* upload([AuthOrchestrationReadScope], "chooser-1")).status).toBe(403);
    expect((yield* upload([AuthOrchestrationOperateScope], "chooser-1")).status).toBe(403);
    expect(answers).toEqual([]);
    expect((yield* upload([AuthPreviewOperateScope], "chooser-1")).status).toBe(204);
    expect(answers).toEqual([
      { chooserId: "chooser-1", files: [{ name: "notes.txt", text: "hello" }] },
    ]);
    expect((yield* upload([AuthPreviewOperateScope], "stale")).status).toBe(409);
  }).pipe(Effect.scoped),
);

const decodeHostSetup = Schema.decodeUnknownEffect(Schema.fromJsonString(PreviewStreamHostSetup));

it.effect.each([
  {
    error: new PreviewBrowserHost.PreviewBrowserSandboxError({
      setupCommand: "sudo supacode browser setup",
    }),
    need: "sandbox",
  },
  {
    error: new PreviewBrowserHost.PreviewBrowserLibrariesError({
      setupCommand: "sudo supacode browser setup",
      libraries: ["libnss3.so"],
    }),
    need: "libraries",
  },
])("tells viewers the command that sets up the host ($need)", ({ error, need }) =>
  Effect.gen(function* () {
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      reportProfiles: () => Effect.void,
      openDownload: () => Effect.succeedNone,
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: () => Effect.fail(new ServerBrowser.ServerBrowserLaunchError({ cause: error })),
    });
    const services = yield* Layer.build(
      HttpRouter.serve(
        routeLayer.pipe(
          Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
          Layer.provide(platformLayer),
        ),
        { disableListenLog: true },
      ).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(makeAuth([AuthOrchestrationReadScope]).layer),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
    const closed = Promise.withResolvers<{ code: number; reason: string }>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new WebSocket(
          `${origin}/api/preview-stream/ws?threadId=thread&tabId=tab&wsTicket=one-use-ticket`,
        );
        socket.addEventListener("close", (event) =>
          closed.resolve({ code: event.code, reason: event.reason }),
        );
        return socket;
      }),
      (socket) => Effect.sync(() => socket.close()),
    );
    const { code, reason } = yield* Effect.promise(() => closed.promise);
    expect(code).toBe(PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE);
    expect(yield* decodeHostSetup(reason)).toEqual({
      need,
      command: "sudo supacode browser setup",
    });
  }).pipe(Effect.scoped),
);

const streamServer = Effect.fnUntraced(function* (browser: ServerBrowser.ServerBrowser["Service"]) {
  const services = yield* Layer.build(
    HttpRouter.serve(
      routeLayer.pipe(
        Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
        Layer.provide(platformLayer),
      ),
      { disableListenLog: true },
    ).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(makeAuth([AuthOrchestrationReadScope]).layer),
    ),
  );
  return HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address).replace(
    /^http/,
    "ws",
  );
});

const streamSocket = Effect.fnUntraced(function* (origin: string, tab: string, versioned = false) {
  const messages = yield* Queue.make<ArrayBuffer | Record<string, unknown>>();
  const closed = Promise.withResolvers<number>();
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new WebSocket(
        `${origin}/api/preview-stream/${versioned ? "ws/v2" : "ws"}?threadId=thread&tabId=${tab}`,
      );
      socket.binaryType = "arraybuffer";
      socket.addEventListener("message", (event) => {
        Queue.offerUnsafe(
          messages,
          typeof event.data === "string" ? JSON.parse(event.data) : event.data,
        );
      });
      socket.addEventListener("close", (event) => closed.resolve(event.code));
      return socket;
    }),
    (socket) => Effect.sync(() => socket.close()),
  );
  return { socket, messages, closed: closed.promise };
});

const browserWithViewer = (attachViewer: ServerBrowser.ServerBrowser["Service"]["attachViewer"]) =>
  ServerBrowser.ServerBrowser.of({
    clearProfile: () => Effect.void,
    reportProfiles: () => Effect.void,
    openDownload: () => Effect.succeedNone,
    answerFileChooser: () => Effect.succeed(false),
    attachViewer,
  });

it.effect("negotiates readiness and lets read-only viewers pause without gaining input scope", () =>
  Effect.gen(function* () {
    const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>();
    const inputs: unknown[] = [];
    const attachments: Array<
      Parameters<ServerBrowser.ServerBrowser["Service"]["attachViewer"]>[0]
    > = [];
    const hidden = Promise.withResolvers<void>();
    const browser = browserWithViewer((input) => {
      attachments.push(input);
      return Effect.succeed({
        output,
        input: (message) =>
          Effect.sync(() => {
            inputs.push(message);
            if (inputs.length === 2) hidden.resolve();
          }),
      });
    });
    yield* Queue.offer(output, { _tag: "viewport", width: 1280, height: 800 });
    const stream = yield* streamSocket(yield* streamServer(browser), "tab", true);
    expect(yield* Queue.take(stream.messages)).toEqual({
      type: "hello",
      version: 2,
      codec: "jpeg",
    });
    stream.socket.send(JSON.stringify({ type: "ready", version: 2, visible: true }));
    expect(yield* Queue.take(stream.messages)).toEqual({
      type: "viewport",
      width: 1280,
      height: 800,
    });
    stream.socket.send(JSON.stringify({ type: "navigate", url: "http://example.test" }));
    stream.socket.send(JSON.stringify({ type: "visibility", visible: false }));
    yield* Effect.promise(() => hidden.promise);
    expect(inputs).toEqual([
      { type: "visibility", visible: true },
      { type: "visibility", visible: false },
    ]);
    expect(attachments[0]).toMatchObject({ canOperate: false, visible: false });
  }).pipe(Effect.scoped),
);

it.effect(
  "keeps only the latest waiting frame and a slow viewer does not stall another viewer",
  () =>
    Effect.gen(function* () {
      const slowOutput = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>();
      const fastOutput = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>();
      const acked: number[] = [];
      const discarded = Promise.withResolvers<void>();
      const frame = (id: number): ServerBrowser.ServerBrowserViewerOutput => ({
        _tag: "frame",
        data: new Uint8Array([id]),
        ack: Effect.sync(() => {
          acked.push(id);
          if (id === 2) discarded.resolve();
        }),
      });
      const browser = browserWithViewer(({ tabId }) =>
        Effect.succeed({
          output: tabId === "slow" ? slowOutput : fastOutput,
          input: () => Effect.void,
        }),
      );
      const origin = yield* streamServer(browser);
      const slow = yield* streamSocket(origin, "slow");
      const fast = yield* streamSocket(origin, "fast");
      yield* Queue.offer(slowOutput, frame(1));
      yield* Queue.offer(fastOutput, frame(10));
      expect(new Uint8Array((yield* Queue.take(slow.messages)) as ArrayBuffer)).toEqual(
        new Uint8Array([1]),
      );
      expect(new Uint8Array((yield* Queue.take(fast.messages)) as ArrayBuffer)).toEqual(
        new Uint8Array([10]),
      );
      fast.socket.send(JSON.stringify({ type: "ack" }));
      yield* Queue.offer(fastOutput, frame(11));
      expect(new Uint8Array((yield* Queue.take(fast.messages)) as ArrayBuffer)).toEqual(
        new Uint8Array([11]),
      );
      yield* Queue.offer(slowOutput, frame(2));
      yield* Queue.offer(slowOutput, frame(3));
      yield* Queue.offer(slowOutput, { _tag: "viewport", width: 3, height: 1 });
      expect(yield* Queue.take(slow.messages)).toEqual({ type: "viewport", width: 3, height: 1 });
      yield* Effect.promise(() => discarded.promise);
      expect(acked).toContain(2);
      expect(acked).not.toContain(1);
      slow.socket.send(JSON.stringify({ type: "ack" }));
      expect(new Uint8Array((yield* Queue.take(slow.messages)) as ArrayBuffer)).toEqual(
        new Uint8Array([3]),
      );
      expect(acked).toContain(1);
    }).pipe(Effect.scoped),
);

it.effect("delivers a large frame with one credit and closes a frame beyond the byte budget", () =>
  Effect.gen(function* () {
    const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>();
    const stream = yield* streamSocket(
      yield* streamServer(
        browserWithViewer(() =>
          Effect.succeed({
            output,
            input: () => Effect.void,
          }),
        ),
      ),
      "tab",
    );
    const large = new Uint8Array(2 * 1024 * 1024);
    large[large.length - 1] = 255;
    yield* Queue.offer(output, { _tag: "frame", data: large, ack: Effect.void });
    const received = (yield* Queue.take(stream.messages)) as ArrayBuffer;
    expect(received.byteLength).toBe(large.byteLength);
    expect(new Uint8Array(received).at(-1)).toBe(255);
    stream.socket.send(JSON.stringify({ type: "ack" }));
    yield* Queue.offer(output, {
      _tag: "frame",
      data: new Uint8Array(8 * 1024 * 1024),
      ack: Effect.void,
    });
    expect(yield* Effect.promise(() => stream.closed)).toBe(1006);
  }).pipe(Effect.scoped),
);
