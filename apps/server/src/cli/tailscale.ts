/**
 * `supaterm tailscale` - sign the running server's built-in Tailscale node in or out, and read
 * its status, through the server's HTTP API.
 */
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  EnvironmentHttpApi,
  isTailnetHostname,
  isTailnetTag,
  type TailnetStatus,
} from "@supaterm/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import { renderTerminalQrCode } from "../startupAccess.ts";
import { baseDirFlag } from "./config.ts";
import {
  type DiscoveredPairTarget,
  discoverPairTarget,
  makePairServerConfig,
  withLiveServerSession,
} from "./pair.ts";

const COMMAND_SESSION_TTL = Duration.seconds(30);
const LOGIN_POLL_INTERVAL = Duration.seconds(2);
const LOGIN_WAIT = Duration.minutes(10);
// Outlives the wait so the last poll is still authorized.
const LOGIN_POLL_SESSION_TTL = Duration.minutes(11);

class TailnetHostnameInvalidError extends Schema.TaggedError<TailnetHostnameInvalidError>()(
  "TailnetHostnameInvalidError",
  { hostname: Schema.String },
) {
  override get message(): string {
    return `"${this.hostname}" is not a valid hostname. Use lowercase letters, digits, and hyphens, at most 63 characters.`;
  }
}

class TailnetTagInvalidError extends Schema.TaggedError<TailnetTagInvalidError>()(
  "TailnetTagInvalidError",
  { tag: Schema.String },
) {
  override get message(): string {
    return `"${this.tag}" is not a valid tag. Tags look like tag:name and start with a letter after tag:.`;
  }
}

class TailnetAuthKeyEmptyError extends Schema.TaggedError<TailnetAuthKeyEmptyError>()(
  "TailnetAuthKeyEmptyError",
  {},
) {
  override get message(): string {
    return "The auth key file is empty.";
  }
}

class TailnetLoginStoppedError extends Schema.TaggedError<TailnetLoginStoppedError>()(
  "TailnetLoginStoppedError",
  { phase: Schema.String, detail: Schema.optionalKey(Schema.String) },
) {
  override get message(): string {
    return this.detail === undefined
      ? `Tailscale sign-in stopped (${this.phase}).`
      : `Tailscale sign-in stopped: ${this.detail}`;
  }
}

class TailnetLoginTimedOutError extends Schema.TaggedError<TailnetLoginTimedOutError>()(
  "TailnetLoginTimedOutError",
  {},
) {
  override get message(): string {
    return "Tailscale sign-in did not finish within 10 minutes. Run `supaterm tailscale status` to check on it, or `supaterm tailscale login` to try again.";
  }
}

const PHASE_LABELS: Record<TailnetStatus["phase"], string> = {
  unavailable: "Unavailable",
  "signed-out": "Signed out",
  starting: "Starting",
  "needs-login": "Waiting for sign-in",
  "needs-approval": "Waiting for approval in the Tailscale admin console",
  running: "Running",
  "needs-reauth": "Needs reauthentication",
  restarting: "Restarting",
  error: "Error",
};

function formatTailnetStatus(status: TailnetStatus): string {
  const { self } = status;
  const lines = [`Built-in Tailscale: ${PHASE_LABELS[status.phase]}`];
  if (status.message !== undefined) lines.push(status.message);
  if (self?.tagged) {
    lines.push(`Tags: ${self.tags.join(", ")}`);
  } else if (self?.loginName !== undefined) {
    lines.push(`Signed in as: ${self.loginName}`);
  }
  if (self?.dnsName !== undefined) lines.push(`Name: ${self.dnsName}`);
  if (status.phase === "running") {
    if (status.serveEnabled) {
      if (status.httpsUrl !== undefined) lines.push(`HTTPS: ${status.httpsUrl}`);
      if (status.httpUrl !== undefined) {
        lines.push(`HTTP: ${status.httpUrl} (limited browser features)`);
      }
    } else {
      lines.push("Serving: off");
    }
    if (status.https !== "ready") {
      const reason = status.httpsMessage ? ` (${status.httpsMessage})` : "";
      lines.push(`HTTPS certificate: ${status.https}${reason}`);
    }
  }
  if (status.phase !== "signed-out" && status.phase !== "unavailable") {
    lines.push(
      status.requireOwner
        ? "Access: only your Tailscale account"
        : "Access: anyone your tailnet policy allows",
    );
  }
  if (status.loggingRequired) {
    lines.push("This tailnet requires Tailscale logging. Allow it in Settings → Connections.");
  }
  return lines.join("\n");
}

const connect = Effect.fn("tailscale.connect")(function* (baseDir: Option.Option<string>) {
  const logLevel = Option.getOrElse(yield* GlobalFlag.LogLevel, () => "Warn" as const);
  const target = yield* discoverPairTarget(Option.getOrUndefined(baseDir));
  const config = yield* makePairServerConfig({ target, logLevel });
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: target.state.origin });
  return { target, config, client };
});

type Connection = Effect.Success<ReturnType<typeof connect>>;

const readStatus = (connection: Connection) =>
  withLiveServerSession(
    connection.config,
    { scopes: [AuthAccessReadScope], ttl: COMMAND_SESSION_TTL, label: "supaterm tailscale status" },
    (headers) => connection.client.tailnet.status({ headers }),
  );

const awaitSignedIn = (connection: Connection) =>
  withLiveServerSession(
    connection.config,
    {
      scopes: [AuthAccessReadScope],
      ttl: LOGIN_POLL_SESSION_TTL,
      label: "supaterm tailscale login",
    },
    (headers) =>
      Effect.gen(function* () {
        let announcedApproval = false;
        while (true) {
          const status = yield* connection.client.tailnet.status({ headers });
          switch (status.phase) {
            case "running":
              return status;
            case "needs-approval":
              if (!announcedApproval) {
                announcedApproval = true;
                yield* Console.log("Waiting for an admin to approve this device…");
              }
              break;
            case "error":
            case "unavailable":
            case "signed-out":
              return yield* new TailnetLoginStoppedError({
                phase: status.phase,
                ...(status.message === undefined ? {} : { detail: status.message }),
              });
            default:
              break;
          }
          yield* Effect.sleep(LOGIN_POLL_INTERVAL);
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: LOGIN_WAIT,
          orElse: () => Effect.fail(new TailnetLoginTimedOutError()),
        }),
      ),
  );

const withLoginSession = <A, E, R>(
  connection: Connection,
  use: (headers: { readonly authorization: string }) => Effect.Effect<A, E, R>,
) =>
  withLiveServerSession(
    connection.config,
    { scopes: [AuthAccessWriteScope], ttl: COMMAND_SESSION_TTL, label: "supaterm tailscale login" },
    use,
  );

const announceLogin = (heading: string, loginUrl: string | null) =>
  loginUrl === null
    ? Effect.void
    : Console.log(
        [
          heading,
          "Open this link on any device to sign in:",
          "",
          renderTerminalQrCode(loginUrl),
          "",
          loginUrl,
          "",
        ].join("\n"),
      );

const describeTarget = (target: DiscoveredPairTarget) =>
  `${target.descriptor.label} (${target.state.origin})`;

const loginCommand = Command.make("login", {
  baseDir: baseDirFlag,
  hostname: Flag.String("hostname").pipe(
    Flag.withDescription(
      "Device name on the tailnet. Defaults to the saved name or a generated one. It becomes part of the HTTPS address and is published in certificate transparency logs.",
    ),
    Flag.optional,
  ),
  tags: Flag.String("tag").pipe(
    Flag.withDescription(
      "Advertise a tag, such as tag:supaterm. Repeat for more. A tagged device is governed by tailnet policy instead of the owner-only limit.",
    ),
    Flag.atLeast(0),
  ),
  authKey: Flag.FileText("auth-key-file").pipe(
    Flag.withDescription(
      "Read a Tailscale auth key from this file to sign in without a browser. The key never appears in arguments or the environment.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Sign the running server's built-in Tailscale node in to a tailnet, or back in when its login expired.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const tags = [...new Set(flags.tags.map((tag) => tag.trim()))];
      const invalidTag = tags.find((tag) => !isTailnetTag(tag));
      if (invalidTag !== undefined) return yield* new TailnetTagInvalidError({ tag: invalidTag });
      const authKey = Option.map(flags.authKey, (value) => value.trim());
      if (Option.isSome(authKey) && authKey.value.length === 0) {
        return yield* new TailnetAuthKeyEmptyError();
      }

      const connection = yield* connect(flags.baseDir);
      const current = yield* readStatus(connection);
      const target = describeTarget(connection.target);
      if (current.phase === "running") {
        return yield* Console.log(
          [`${target} is already signed in to Tailscale.`, formatTailnetStatus(current)].join("\n"),
        );
      }

      if (current.phase === "starting") {
        yield* Console.log(`Tailscale is starting on ${target}…`);
      } else if (current.phase === "signed-out" || current.phase === "unavailable") {
        const hostname = Option.getOrElse(
          Option.map(flags.hostname, (value) => value.trim().toLowerCase()),
          () => current.hostname ?? current.suggestedHostname,
        );
        if (!isTailnetHostname(hostname)) {
          return yield* new TailnetHostnameInvalidError({ hostname });
        }
        const { loginUrl } = yield* withLoginSession(connection, (headers) =>
          connection.client.tailnet.signIn({
            headers,
            payload: {
              hostname,
              tags,
              ...(Option.isSome(authKey) ? { authKey: authKey.value } : {}),
            },
          }),
        );
        yield* announceLogin(`Signing ${target} in to Tailscale as ${hostname}.`, loginUrl);
      } else {
        if (Option.isSome(flags.hostname) || tags.length > 0 || Option.isSome(authKey)) {
          yield* Console.log(
            "Note: this server is already enrolled, so --hostname, --tag, and --auth-key-file are ignored. To change them, run `supaterm tailscale logout` first.",
          );
        }
        const { loginUrl } = yield* withLoginSession(connection, (headers) =>
          connection.client.tailnet.reauthenticate({ headers }),
        );
        yield* announceLogin(`Signing ${target} back in to Tailscale.`, loginUrl);
      }
      const status = yield* awaitSignedIn(connection);
      yield* Console.log(formatTailnetStatus(status));
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

const statusCommand = Command.make("status", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Show the running server's built-in Tailscale status."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const connection = yield* connect(flags.baseDir);
      yield* Console.log(formatTailnetStatus(yield* readStatus(connection)));
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

const logoutCommand = Command.make("logout", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Sign the built-in Tailscale node out, stop serving, and remove its node state.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const connection = yield* connect(flags.baseDir);
      const { remoteLogoutConfirmed } = yield* withLiveServerSession(
        connection.config,
        {
          scopes: [AuthAccessWriteScope],
          ttl: COMMAND_SESSION_TTL,
          label: "supaterm tailscale logout",
        },
        (headers) => connection.client.tailnet.signOut({ headers }),
      );
      yield* Console.log(
        remoteLogoutConfirmed
          ? "Signed out of Tailscale."
          : "Signed out on this machine, but Tailscale did not confirm the logout. If the device still appears at https://login.tailscale.com/admin/machines, remove it there.",
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

export const tailscaleCommand = Command.make("tailscale").pipe(
  Command.withDescription("Manage the running server's built-in Tailscale node."),
  Command.withSubcommands([loginCommand, statusCommand, logoutCommand]),
);
