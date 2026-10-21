import { AuthAccessReadScope, AuthAccessWriteScope, EnvironmentHttpApi } from "@supaterm/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as TailnetNode from "./TailnetNode.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "tailnet",
  Effect.fnUntraced(function* (handlers) {
    const tailnet = yield* TailnetNode.TailnetNode;
    return handlers
      .handle("status", () =>
        requireEnvironmentScope(AuthAccessReadScope).pipe(Effect.andThen(tailnet.currentStatus)),
      )
      .handle("signIn", ({ payload }) =>
        requireEnvironmentScope(AuthAccessWriteScope).pipe(Effect.andThen(tailnet.signIn(payload))),
      )
      .handle("signOut", () =>
        requireEnvironmentScope(AuthAccessWriteScope).pipe(Effect.andThen(tailnet.signOut)),
      );
  }),
);
