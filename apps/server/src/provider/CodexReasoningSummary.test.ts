import { assert, describe, it } from "@effect/vitest";
import * as CodexError from "effect-codex-app-server/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import { TestClock } from "effect/testing";

import {
  resolveCodexReasoningSummary,
  sanitizeCodexConfigReadFrame,
} from "./CodexReasoningSummary.ts";

const configuredSummary = (summary: unknown, origin = "user") => ({
  config: { model_reasoning_summary: summary },
  origins: { model_reasoning_summary: { name: { type: origin } } },
});

describe("Codex reasoning summary config", () => {
  it("keeps only the summary and origin in recorded config responses", () => {
    const response = {
      ...configuredSummary("concise"),
      config: {
        model_reasoning_summary: "concise",
        mcp_servers: {
          probe: {
            env: { CUSTOM_CREDENTIAL: "credential-sentinel", AWS_ACCESS_KEY_ID: "access-sentinel" },
            http_headers: { "X-Custom-Credential": "header-sentinel" },
          },
        },
      },
      layers: [{ config: { secret: "layer-sentinel" } }],
    };
    assert.deepStrictEqual(sanitizeCodexConfigReadFrame({ id: 2, result: response }), {
      id: 2,
      result: configuredSummary("concise"),
    });
  });

  it("removes invalid config values and error details from recordings", () => {
    assert.deepStrictEqual(
      sanitizeCodexConfigReadFrame({ id: 2, result: configuredSummary("invalid-sentinel") }),
      { id: 2, result: { config: {}, origins: {} } },
    );
    assert.deepStrictEqual(
      sanitizeCodexConfigReadFrame({
        id: 3,
        error: { code: -32603, message: "invalid config: error-sentinel", data: "data-sentinel" },
      }),
      { id: 3, error: { code: -32603, message: "Failed to read Codex reasoning summary config." } },
    );
  });

  it("sanitizes both fields when a response carries a result and an error", () => {
    assert.deepStrictEqual(
      sanitizeCodexConfigReadFrame({
        id: 2,
        result: configuredSummary("result-sentinel"),
        error: { code: -32603, message: "error-sentinel", data: "data-sentinel" },
      }),
      {
        id: 2,
        result: { config: {}, origins: {} },
        error: { code: -32603, message: "Failed to read Codex reasoning summary config." },
      },
    );
  });

  it.effect.each(["auto", "concise", "detailed", "none"] as const)(
    "honors an explicit %s summary",
    (summary) =>
      Effect.gen(function* () {
        const result = yield* resolveCodexReasoningSummary(
          { request: () => Effect.succeed(configuredSummary(summary)) },
          "/workspace",
        );
        assert.strictEqual(result, summary);
      }),
  );

  it.effect.each(["project", "sessionFlags", "system", "mdm", "enterpriseManaged"])(
    "honors the effective %s config layer",
    (origin) =>
      Effect.gen(function* () {
        const result = yield* resolveCodexReasoningSummary(
          { request: () => Effect.succeed(configuredSummary("none", origin)) },
          "/workspace",
        );
        assert.strictEqual(result, "none");
      }),
  );

  it.effect.each([
    { config: {}, origins: {} },
    configuredSummary(null),
    configuredSummary("none", "packagedDefaults"),
    { config: { model_reasoning_summary: "none" }, origins: {} },
  ])("uses auto without an explicit preference %#", (response) =>
    Effect.gen(function* () {
      const result = yield* resolveCodexReasoningSummary(
        { request: () => Effect.succeed(response) },
        "/workspace",
      );
      assert.strictEqual(result, "auto");
    }),
  );

  it.effect("reads the destination workspace and refreshes the preference for each turn", () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; params: unknown }> = [];
      let summary = "none";
      const client = {
        request: (method: string, params?: unknown) =>
          Effect.sync(() => {
            requests.push({ method, params });
            return configuredSummary(summary);
          }),
      };
      assert.strictEqual(yield* resolveCodexReasoningSummary(client, "/workspace"), "none");
      summary = "concise";
      assert.strictEqual(yield* resolveCodexReasoningSummary(client, "/workspace"), "concise");
      assert.deepStrictEqual(requests, [
        { method: "config/read", params: { cwd: "/workspace" } },
        { method: "config/read", params: { cwd: "/workspace" } },
      ]);
    }),
  );

  it.effect("ignores unrelated config fields from a newer app server", () =>
    Effect.gen(function* () {
      const response = {
        config: {
          model_reasoning_summary: "concise",
          model_reasoning_effort: "new-effort",
          service_tier: { future: true },
        },
        origins: {
          model_reasoning_summary: { name: { type: "sessionFlags" } },
          service_tier: "future-origin",
        },
      };
      const result = yield* resolveCodexReasoningSummary(
        { request: () => Effect.succeed(response) },
        "/workspace",
      );
      assert.strictEqual(result, "concise");
    }),
  );

  it.effect("falls back when the app server does not support config reads", () =>
    Effect.gen(function* () {
      const result = yield* resolveCodexReasoningSummary(
        {
          request: () =>
            Effect.fail(
              new CodexError.CodexAppServerRequestError({
                method: "config/read",
                code: -32601,
                errorMessage: "Method not found",
              }),
            ),
        },
        "/workspace",
      );
      assert.strictEqual(result, "auto");
    }),
  );

  it.effect("falls back without logging invalid config contents", () => {
    const messages: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ message }) => messages.push(message));
    const secret = "test-config-secret";
    return Effect.gen(function* () {
      const result = yield* resolveCodexReasoningSummary(
        { request: () => Effect.succeed(configuredSummary(secret)) },
        "/workspace",
      );
      assert.strictEqual(result, "auto");
      assert.isNotEmpty(messages);
      assert.notInclude(JSON.stringify(messages), secret);
    }).pipe(Effect.provide(Logger.layer([logger])));
  });

  it.effect("falls back when a config read never answers", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const resolution = yield* resolveCodexReasoningSummary(
        {
          request: () => Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
        },
        "/workspace",
      ).pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(yield* Fiber.join(resolution), "auto");
    }),
  );
});
