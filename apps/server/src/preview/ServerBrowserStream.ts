import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  AuthPreviewOperateScope,
  AuthOrchestrationReadScope,
  PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE,
  PREVIEW_STREAM_VERSION,
  PreviewStreamHello,
  PreviewStreamHostSetup,
  PreviewStreamReady,
  PreviewStreamVisibility,
} from "@supacode/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  HttpPlatform,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  Multipart,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest } from "../auth/http.ts";
import { assetResponseHeaders } from "../http.ts";
import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

const PREVIEW_STREAM_ROUTE_PREFIX = "/api/preview-stream";
/** Matches `PREVIEW_STREAM_TAB_GONE_CODE` in the client. */
const TAB_GONE_CODE = 4404;

const DEFAULT_QUALITY = 70;
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const textDecoder = new TextDecoder();
const isReady = Schema.is(PreviewStreamReady);
const isVisibility = Schema.is(PreviewStreamVisibility);
const encodeHello = Schema.encodeSync(Schema.fromJsonString(PreviewStreamHello));

const intParam = (params: URLSearchParams, name: string, fallback: number, max: number) => {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), max) : fallback;
};

const isAck = (message: unknown) =>
  typeof message === "object" && message !== null && "type" in message && message.type === "ack";

const parseMessage = (chunk: Uint8Array | string): unknown => {
  try {
    return JSON.parse(typeof chunk === "string" ? chunk : textDecoder.decode(chunk));
  } catch {
    return null;
  }
};

const makeHandler = (browser: ServerBrowser.ServerBrowser["Service"]) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    if (url.value.pathname === `${PREVIEW_STREAM_ROUTE_PREFIX}/download`) {
      return yield* serveDownload(browser, url.value.searchParams);
    }
    if (url.value.pathname === `${PREVIEW_STREAM_ROUTE_PREFIX}/upload`) {
      return request.method === "POST"
        ? yield* receiveUpload(browser, url.value.searchParams)
        : HttpServerResponse.text("Method Not Allowed", { status: 405 });
    }
    const versioned = url.value.pathname === `${PREVIEW_STREAM_ROUTE_PREFIX}/ws/v2`;
    if (
      (!versioned && url.value.pathname !== `${PREVIEW_STREAM_ROUTE_PREFIX}/ws`) ||
      request.headers.upgrade?.toLowerCase() !== "websocket"
    ) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const session = yield* authenticateMediaRequest(AuthOrchestrationReadScope);
    const params = url.value.searchParams;
    const canOperate =
      session.scopes.includes(AuthPreviewOperateScope) && params.get("interactive") !== "false";
    const threadId = params.get("threadId") ?? "";
    const tabId = params.get("tabId") ?? "";
    if (threadId.length === 0 || tabId.length === 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const attached = yield* browser
          .attachViewer({
            threadId,
            tabId,
            canOperate,
            maxWidth: intParam(params, "maxWidth", 1280, 7680),
            maxHeight: intParam(params, "maxHeight", 800, 4320),
            quality: intParam(params, "quality", DEFAULT_QUALITY, 100),
            ...(versioned ? { visible: false } : {}),
          })
          .pipe(
            Effect.map((viewer) => ({ _tag: "attached" as const, viewer })),
            Effect.catchTags({
              ServerBrowserTabNotFoundError: () => Effect.succeed({ _tag: "gone" as const }),
              ServerBrowserLaunchError: (error) => {
                const setup = hostSetup(error.cause);
                return setup === undefined
                  ? Effect.fail(error)
                  : Effect.succeed({ _tag: "hostSetup" as const, reason: encodeHostSetup(setup) });
              },
            }),
          );
        const incoming = NodeHttpServerRequest.toIncomingMessage(request);
        // JPEGs are already compressed. Disabling deflate also keeps all
        // pending writes in the socket buffer we bound below, not a zlib queue.
        delete incoming.headers["sec-websocket-extensions"];
        const transport = incoming.socket;
        const socket = yield* request.upgrade;
        // The reader performs the upgrade; writes wait for it.
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        // A refused upgrade reads as an auth failure to ticket clients, so a
        // missing tab is a close code they stop on.
        const gone = writer.write(new Socket.CloseEvent(TAB_GONE_CODE, "tab closed"));
        if (attached._tag === "gone") {
          yield* gone;
          return HttpServerResponse.empty();
        }
        if (attached._tag === "hostSetup") {
          yield* writer.write(
            new Socket.CloseEvent(PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE, attached.reason),
          );
          return HttpServerResponse.empty();
        }
        const viewer = attached.viewer;
        const ready = yield* Deferred.make<void>();
        const credits = yield* Queue.make<void>({ capacity: 1, strategy: "dropping" });
        const frames = yield* Queue.make<
          Extract<ServerBrowser.ServerBrowserViewerOutput, { _tag: "frame" }>
        >({ capacity: 1, strategy: "dropping" });
        let unacknowledged: Effect.Effect<void> | undefined;
        let visible = !versioned;
        if (!versioned) yield* Deferred.succeed(ready, undefined);
        yield* Queue.offer(credits, undefined);
        const disconnectSlowViewer = Effect.sync(() => transport.destroy()).pipe(
          Effect.andThen(Effect.interrupt),
        );
        const write = (data: Uint8Array | string) =>
          Effect.suspend(() => {
            const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
            // Include the WebSocket frame header in the budget.
            if (transport.writableLength + bytes + 14 > MAX_SOCKET_BUFFER_BYTES) {
              return disconnectSlowViewer;
            }
            return writer.write(data);
          });
        if (versioned) {
          yield* write(
            encodeHello({ type: "hello", version: PREVIEW_STREAM_VERSION, codec: "jpeg" }),
          );
        }
        const sendOutput = Deferred.await(ready).pipe(
          Effect.andThen(Queue.take(viewer.output)),
          Effect.flatMap((output) => {
            switch (output._tag) {
              case "frame":
                return Effect.gen(function* () {
                  const dropped = yield* Queue.clear(frames);
                  for (const item of dropped) yield* item.ack.pipe(Effect.forkScoped);
                  if (!visible) yield* output.ack.pipe(Effect.forkScoped);
                  else yield* Queue.offer(frames, output);
                });
              case "viewport":
              case "control":
              case "clipboard":
              case "download":
              case "fileChooser":
              case "fileChooserClosed":
              case "popup":
              case "pointer":
              case "probe": {
                const { _tag: type, ...data } = output;
                return write(JSON.stringify({ type, ...data }));
              }
              case "gone":
                return gone.pipe(Effect.andThen(Effect.interrupt));
              case "reconnect":
                return writer
                  .write(new Socket.CloseEvent(1012, "reconnect"))
                  .pipe(Effect.andThen(Effect.interrupt));
            }
          }),
        );
        const sendFrames = Effect.gen(function* () {
          yield* Deferred.await(ready);
          yield* Queue.take(credits);
          const frame = yield* Queue.take(frames);
          unacknowledged = frame.ack;
          yield* write(frame.data);
        });
        const receive = (chunk: Uint8Array | string) => {
          const message = parseMessage(chunk);
          if (versioned && (isReady(message) || isVisibility(message))) {
            if (!isReady(message) && !Deferred.isDoneUnsafe(ready)) return Effect.void;
            visible = message.visible;
            return Effect.gen(function* () {
              yield* viewer.input({ type: "visibility", visible });
              if (!visible) {
                const dropped = yield* Queue.clear(frames);
                for (const frame of dropped) yield* frame.ack.pipe(Effect.forkScoped);
              }
              if (isReady(message)) yield* Deferred.succeed(ready, undefined);
            });
          }
          // Ownership serializes actions in the service. Keep reading so dialog
          // replies and takeover can unblock an action already waiting on the page.
          if (!isAck(message))
            return canOperate
              ? viewer.input(message).pipe(Effect.forkScoped, Effect.asVoid)
              : Effect.void;
          const ack = unacknowledged;
          if (!ack) return Effect.void;
          unacknowledged = undefined;
          return ack.pipe(
            Effect.forkScoped,
            Effect.andThen(Queue.offer(credits, undefined)),
            Effect.asVoid,
          );
        };
        const receiveInput = reader.pull.pipe(
          Effect.flatMap((chunks) => Effect.forEach(chunks, receive, { discard: true })),
        );
        yield* Effect.forever(sendFrames).pipe(Effect.forkScoped);
        if (versioned) {
          yield* Deferred.await(ready).pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () =>
                writer
                  .write(new Socket.CloseEvent(1002, "stream readiness required"))
                  .pipe(Effect.andThen(Effect.interrupt)),
            }),
            Effect.forkScoped,
          );
        }
        return yield* Effect.raceFirst(Effect.forever(sendOutput), Effect.forever(receiveInput));
      }),
    ).pipe(
      Effect.catchTags({
        ServerBrowserLaunchError: (error) =>
          Effect.logWarning("server preview browser failed to start", { cause: error.cause }).pipe(
            Effect.as(HttpServerResponse.text("Service Unavailable", { status: 503 })),
          ),
      }),
      // A dropped socket is a normal end of viewing.
      Effect.catch(() => Effect.succeed(HttpServerResponse.empty())),
    );
  });

/** Which host setup a launch failure is missing, and the command that fixes it. */
const hostSetup = (cause: unknown): PreviewStreamHostSetup | undefined =>
  isSandboxError(cause)
    ? { need: "sandbox", command: cause.setupCommand }
    : isLibrariesError(cause)
      ? { need: "libraries", command: cause.setupCommand }
      : undefined;
const isSandboxError = Schema.is(PreviewBrowserHost.PreviewBrowserSandboxError);
const isLibrariesError = Schema.is(PreviewBrowserHost.PreviewBrowserLibrariesError);
const encodeHostSetup = Schema.encodeSync(Schema.fromJsonString(PreviewStreamHostSetup));

/** `GET /api/preview-stream/download?threadId&tabId&id`: a file a server tab downloaded. */
const serveDownload = (browser: ServerBrowser.ServerBrowser["Service"], params: URLSearchParams) =>
  Effect.gen(function* () {
    yield* authenticateMediaRequest(AuthOrchestrationReadScope);
    const download = yield* browser.openDownload({
      threadId: params.get("threadId") ?? "",
      tabId: params.get("tabId") ?? "",
      downloadId: params.get("id") ?? "",
    });
    if (Option.isNone(download)) return HttpServerResponse.text("Not Found", { status: 404 });
    return yield* HttpServerResponse.file(download.value.path, {
      headers: assetResponseHeaders(download.value.path, {
        download: true,
        fileName: download.value.fileName,
      }),
    });
  });

const UPLOAD_MAX_FILE_BYTES = 100 * 1024 * 1024;
const UPLOAD_MAX_FILES = 20;

/**
 * `POST /api/preview-stream/upload?threadId&tabId&chooser` with multipart `file`
 * parts: answers the page's open file picker. No parts cancels it.
 */
const receiveUpload = (browser: ServerBrowser.ServerBrowser["Service"], params: URLSearchParams) =>
  Effect.gen(function* () {
    yield* authenticateMediaRequest(AuthPreviewOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const fs = yield* FileSystem.FileSystem;
    const parts = yield* request.multipart.pipe(
      Effect.provideContext(
        Multipart.limitsServices({
          maxParts: UPLOAD_MAX_FILES,
          maxFileSize: UPLOAD_MAX_FILE_BYTES,
          maxTotalSize: UPLOAD_MAX_FILE_BYTES,
        }),
      ),
    );
    const files = yield* Effect.forEach(
      Object.values(parts).flatMap((value) =>
        Array.isArray(value) ? value.filter(Multipart.isPersistedFile) : [],
      ),
      (file) =>
        fs.readFile(file.path).pipe(
          Effect.map((bytes) => ({
            name: file.name,
            mimeType: file.contentType,
            buffer: Buffer.from(bytes),
          })),
        ),
    );
    const answered = yield* browser.answerFileChooser({
      threadId: params.get("threadId") ?? "",
      tabId: params.get("tabId") ?? "",
      chooserId: params.get("chooser") ?? "",
      files,
    });
    return answered
      ? HttpServerResponse.empty({ status: 204 })
      : HttpServerResponse.text("The page's file picker is no longer open.", { status: 409 });
  }).pipe(Effect.scoped);

// Capture the browser because handlers only see request-scoped services.
export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const browser = yield* ServerBrowser.ServerBrowser;
    const platform = yield* Effect.context<
      HttpPlatform.HttpPlatform | FileSystem.FileSystem | Path.Path
    >();
    const handler = makeHandler(browser).pipe(Effect.provideContext(platform));
    yield* router.add("GET", `${PREVIEW_STREAM_ROUTE_PREFIX}/*`, handler);
    yield* router.add("POST", `${PREVIEW_STREAM_ROUTE_PREFIX}/upload`, handler);
  }),
);
