// @effect-diagnostics nodeBuiltinImport:off -- The ingress owns raw local sockets handed to the Node HTTP server, plus the lstat ownership checks that guard them.
// @effect-diagnostics globalTimers:off -- Each preamble read owns a deadline it clears on every completion path.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import type * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@supaterm/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

const MAX_PREAMBLE_BYTES = 8 * 1024;
const PREAMBLE_TIMEOUT_MS = 5_000;
const ACCEPTED = Buffer.from([1]);
const REJECTED = Buffer.from([0]);

const TailnetPeer = Schema.Struct({
  ip: Schema.String,
  nodeId: Schema.optionalKey(Schema.String),
  nodeName: Schema.optionalKey(Schema.String),
  userId: Schema.optionalKey(Schema.String),
  loginName: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  tagged: Schema.Boolean,
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type TailnetPeer = typeof TailnetPeer.Type;

const TailnetIngressSelf = Schema.Struct({
  userId: Schema.optionalKey(Schema.String),
  tagged: Schema.Boolean,
});
export type TailnetIngressSelf = typeof TailnetIngressSelf.Type;

const TailnetPreamble = Schema.Struct({
  v: Schema.Literal(1),
  secret: Schema.String,
  tls: Schema.Boolean,
  peer: Schema.NullOr(TailnetPeer),
  self: TailnetIngressSelf,
});
const decodePreamble = Schema.decodeUnknownOption(Schema.fromJsonString(TailnetPreamble));

export interface TailnetConnection {
  readonly tls: boolean;
  readonly peer: TailnetPeer | null;
  readonly self: TailnetIngressSelf;
}

class TailnetIngressListenError extends Schema.TaggedError<TailnetIngressListenError>()(
  "TailnetIngressListenError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not open the local socket for built-in Tailscale connections.";
  }
}

/**
 * Tailscale's own same-user rule (`peerapi.go`): neither side tagged and both owned by one user.
 * The header self must also agree with the latest streamed self, so a stale or forged header
 * cannot outlive a change of account or tags.
 */
export function isTailnetOwnerAllowed(input: {
  readonly requireOwner: boolean;
  readonly connection: TailnetConnection;
  readonly latestSelf: TailnetIngressSelf | undefined;
}): boolean {
  if (!input.requireOwner) return true;
  const { peer, self } = input.connection;
  const latest = input.latestSelf;
  return (
    peer !== null &&
    latest !== undefined &&
    !peer.tagged &&
    !self.tagged &&
    !latest.tagged &&
    peer.userId !== undefined &&
    peer.userId === self.userId &&
    self.userId === latest.userId
  );
}

const connections = new WeakMap<NodeNet.Socket, TailnetConnection>();

const connectionOfSocket = (socket: unknown) =>
  socket instanceof NodeNet.Socket ? connections.get(socket) : undefined;

export const tailnetPeerOf = (request: HttpServerRequest.HttpServerRequest) => {
  const source = request.source;
  return source instanceof Object && "socket" in source
    ? (connectionOfSocket(source.socket)?.peer ?? undefined)
    : undefined;
};

/**
 * The sidecar terminates TLS, so the scheme comes from the socket and never from the client.
 * Prepended, so it runs before Effect reads the request. Install it before
 * `rejectRequestsUntilServing`, whose newListener hook treats any new request listener as
 * the serving handoff.
 */
export function installTailnetForwardedHeaders<T extends NodeHttp.Server>(server: T): T {
  const rewrite = (request: NodeHttp.IncomingMessage) => {
    const connection = connectionOfSocket(request.socket);
    if (connection === undefined) return;
    request.headers["x-forwarded-proto"] = connection.tls ? "https" : "http";
    delete request.headers["x-forwarded-host"];
    delete request.headers["x-forwarded-for"];
  };
  server.prependListener("request", rewrite);
  server.prependListener("upgrade", rewrite);
  return server;
}

const secretsMatch = (expected: Buffer, presented: string) => {
  const candidate = Buffer.from(presented, "utf8");
  return candidate.length === expected.length && NodeCrypto.timingSafeEqual(candidate, expected);
};

const listenOn = (server: NodeNet.Server, address: string) =>
  new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address);
  });

const closeServer = (server: NodeNet.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

async function makePrivateDirectory(userId: number | undefined) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "supaterm-tn-"));
  const stat = await NodeFSP.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (userId !== undefined && stat.uid !== userId) ||
    (stat.mode & 0o077) !== 0
  ) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
    throw new Error("The ingress directory is not private to this user.");
  }
  return directory;
}

export class TailnetIngress extends Context.Service<
  TailnetIngress,
  {
    /** Returns the address the sidecar dials; closing the scope drops every socket it accepted. */
    readonly listen: (options: {
      readonly secret: string;
      readonly authorize: (connection: TailnetConnection) => boolean;
    }) => Effect.Effect<string, TailnetIngressListenError, Scope.Scope>;
    /** Destroys every live socket the predicate no longer allows and returns how many. */
    readonly revoke: (allow: (connection: TailnetConnection) => boolean) => Effect.Effect<number>;
  }
>()("supaterm/tailnet/TailnetIngress") {}

const make = Effect.fn("TailnetIngress.make")(function* (accept: (socket: NodeNet.Socket) => void) {
  const live = new Set<NodeNet.Socket>();
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;

  const handle = (
    socket: NodeNet.Socket,
    expected: Buffer,
    authorize: (connection: TailnetConnection) => boolean,
    owned: Set<NodeNet.Socket>,
  ) => {
    owned.add(socket);
    socket.once("close", () => owned.delete(socket));
    let buffered: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), PREAMBLE_TIMEOUT_MS);
    const drop = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.destroy();
    };
    const onError = () => socket.destroy();
    const onData = (chunk: Buffer) => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length >= MAX_PREAMBLE_BYTES) drop();
        return;
      }
      // The sidecar holds client bytes until the verdict, so anything after the line is a
      // protocol violation rather than early request data.
      if (newline >= MAX_PREAMBLE_BYTES || newline !== buffered.length - 1) return drop();
      const preamble = decodePreamble(buffered.subarray(0, newline).toString("utf8"));
      if (Option.isNone(preamble) || !secretsMatch(expected, preamble.value.secret)) {
        return drop();
      }
      clearTimeout(timer);
      socket.removeListener("data", onData);
      const connection: TailnetConnection = {
        tls: preamble.value.tls,
        peer: preamble.value.peer,
        self: preamble.value.self,
      };
      if (!authorize(connection)) {
        runFork(
          Effect.logDebug("Rejected a Tailscale connection outside the owner limit.", {
            tagged: connection.peer?.tagged ?? null,
          }),
        );
        socket.end(REJECTED);
        return;
      }
      socket.removeListener("error", onError);
      connections.set(socket, connection);
      live.add(socket);
      socket.once("close", () => live.delete(socket));
      accept(socket);
      // Only after the HTTP server owns the socket, so its parser sees the first request byte.
      if (!socket.destroyed) socket.write(ACCEPTED);
    };
    socket.on("error", onError);
    socket.on("data", onData);
  };

  const listen: TailnetIngress["Service"]["listen"] = (options) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const expected = Buffer.from(options.secret, "utf8");
          const owned = new Set<NodeNet.Socket>();
          const server = NodeNet.createServer((socket) =>
            handle(socket, expected, options.authorize, owned),
          );
          if (platform === "win32") {
            const address = `\\\\.\\pipe\\supaterm-tailnet-${NodeCrypto.randomBytes(8).toString("hex")}`;
            await listenOn(server, address);
            return { address, server, owned, directory: null };
          }
          const directory = await makePrivateDirectory(userId);
          try {
            const address = NodePath.join(directory, "i.sock");
            await listenOn(server, address);
            await NodeFSP.chmod(address, 0o600);
            return { address, server, owned, directory };
          } catch (error) {
            await closeServer(server);
            await NodeFSP.rm(directory, { recursive: true, force: true });
            throw error;
          }
        },
        catch: (cause) => new TailnetIngressListenError({ cause }),
      }),
      (listener) =>
        Effect.promise(async () => {
          for (const socket of listener.owned) socket.destroy();
          await closeServer(listener.server);
          if (listener.directory !== null) {
            await NodeFSP.rm(listener.directory, { recursive: true, force: true });
          }
        }),
    ).pipe(Effect.map((listener) => listener.address));

  const revoke: TailnetIngress["Service"]["revoke"] = (allow) =>
    Effect.sync(() => {
      let destroyed = 0;
      for (const socket of live) {
        const connection = connections.get(socket);
        if (connection !== undefined && allow(connection)) continue;
        socket.destroy();
        destroyed += 1;
      }
      return destroyed;
    });

  return TailnetIngress.of({ listen, revoke });
});

export const layer = (accept: (socket: NodeNet.Socket) => void) =>
  Layer.effect(TailnetIngress, make(accept));
