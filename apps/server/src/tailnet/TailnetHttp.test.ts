import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  TailnetError,
  type TailnetStatus,
} from "@supaterm/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApiTest from "effect/http-api/HttpApiTest";

import * as TailnetHttp from "./TailnetHttp.ts";
import * as TailnetNode from "./TailnetNode.ts";

const status: TailnetStatus = {
  phase: "signed-out",
  suggestedHostname: "khoi-abcdefghij-supaterm",
  tags: [],
  serveEnabled: true,
  requireOwner: true,
  loggingAllowed: false,
  loggingRequired: false,
  https: "pending",
};

const LOGIN_URL = "https://login.tailscale.com/a/reauth";

const makeClient = HttpApiTest.groups(EnvironmentHttpApi, ["tailnet"]);

const run = <A, E>(
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  call: (client: Effect.Success<typeof makeClient>) => Effect.Effect<A, E>,
) => {
  const calls: Array<string> = [];
  const node = Layer.mock(TailnetNode.TailnetNode)({
    currentStatus: Effect.succeed(status),
    signIn: (input) =>
      Effect.sync(() => calls.push(`signIn ${input.hostname}`)).pipe(
        Effect.andThen(Effect.fail(new TailnetError({ reason: "busy" }))),
      ),
    reauthenticate: Effect.sync(() => calls.push("reauthenticate")).pipe(
      Effect.as({ loginUrl: LOGIN_URL }),
    ),
  });
  const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (next) =>
    Effect.provideService(next, EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make("tailnet-test-session"),
      subject: "tailnet-test",
      method: "bearer-access-token",
      scopes: new Set(scopes),
    }),
  );
  return makeClient.pipe(
    Effect.flatMap(call),
    Effect.result,
    Effect.map((result) => ({ result, calls })),
    Effect.provide(
      Layer.mergeAll(
        TailnetHttp.layer.pipe(Layer.provide(node), Layer.provideMerge(auth)),
        HttpServer.layerServices,
      ),
    ),
    Effect.scoped,
  );
};

it.effect("reads status with access:read and nothing broader", () =>
  Effect.gen(function* () {
    const denied = yield* run([AuthAccessWriteScope], (client) =>
      client.tailnet.status({ headers: {} }),
    );
    expect(denied.result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "EnvironmentScopeRequiredError", requiredScope: AuthAccessReadScope },
    });
    const allowed = yield* run([AuthAccessReadScope], (client) =>
      client.tailnet.status({ headers: {} }),
    );
    expect(allowed.result).toMatchObject({ _tag: "Success", success: status });
  }),
);

it.effect("signs in only with access:write and passes Tailscale failures through", () =>
  Effect.gen(function* () {
    const payload = { hostname: "khoi-laptop", tags: [] };
    const denied = yield* run([AuthAccessReadScope], (client) =>
      client.tailnet.signIn({ headers: {}, payload }),
    );
    expect(denied.result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "EnvironmentScopeRequiredError", requiredScope: AuthAccessWriteScope },
    });
    expect(denied.calls).toEqual([]);

    const allowed = yield* run([AuthAccessWriteScope], (client) =>
      client.tailnet.signIn({ headers: {}, payload }),
    );
    expect(allowed.result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TailnetError", reason: "busy" },
    });
    expect(allowed.calls).toEqual(["signIn khoi-laptop"]);
  }),
);

it.effect("reauthenticates only with access:write and returns the login link", () =>
  Effect.gen(function* () {
    const denied = yield* run([AuthAccessReadScope], (client) =>
      client.tailnet.reauthenticate({ headers: {} }),
    );
    expect(denied.result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "EnvironmentScopeRequiredError", requiredScope: AuthAccessWriteScope },
    });
    expect(denied.calls).toEqual([]);

    const allowed = yield* run([AuthAccessWriteScope], (client) =>
      client.tailnet.reauthenticate({ headers: {} }),
    );
    expect(allowed.result).toMatchObject({ _tag: "Success", success: { loginUrl: LOGIN_URL } });
    expect(allowed.calls).toEqual(["reauthenticate"]);
  }),
);
