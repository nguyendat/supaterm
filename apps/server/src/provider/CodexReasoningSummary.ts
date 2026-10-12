import { errorTag } from "@supacode/shared/observability";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const CodexReasoningSummaryConfig = Schema.Struct({
  config: Schema.Struct({
    model_reasoning_summary: Schema.optionalKey(
      Schema.NullOr(CodexSchema.V2TurnStartParams__ReasoningSummary),
    ),
  }),
  origins: Schema.Struct({
    model_reasoning_summary: Schema.optionalKey(
      Schema.Struct({ name: Schema.Struct({ type: Schema.String }) }),
    ),
  }),
});

const decodeCodexReasoningSummaryConfig = Schema.decodeUnknownEffect(CodexReasoningSummaryConfig);
const decodeCodexReasoningSummaryConfigOption = Schema.decodeUnknownOption(
  CodexReasoningSummaryConfig,
);

export function sanitizeCodexConfigReadFrame(frame: unknown): unknown {
  if (typeof frame !== "object" || frame === null) return frame;
  let sanitizedFrame = frame;
  if ("result" in frame) {
    sanitizedFrame = {
      ...sanitizedFrame,
      result: Option.getOrElse(decodeCodexReasoningSummaryConfigOption(frame.result), () => ({
        config: {},
        origins: {},
      })),
    };
  }
  if ("error" in frame) {
    const error = frame.error;
    return {
      ...sanitizedFrame,
      error: {
        ...(typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "number"
          ? { code: error.code }
          : {}),
        message: "Failed to read Codex reasoning summary config.",
      },
    };
  }
  return sanitizedFrame;
}

export const resolveCodexReasoningSummary = Effect.fn("resolveCodexReasoningSummary")(
  function* (
    client: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">,
    cwd: string | null,
  ) {
    const response = yield* client.request("config/read", { cwd });
    const { config, origins } = yield* decodeCodexReasoningSummaryConfig(response);
    const origin = origins.model_reasoning_summary?.name.type;
    if (origin === undefined || origin === "packagedDefaults") return "auto";
    return config.model_reasoning_summary ?? "auto";
  },
  Effect.timeout("5 seconds"),
  Effect.catch((error) =>
    Effect.logWarning("Failed to read Codex reasoning summary config.", {
      errorTag: errorTag(error),
    }).pipe(Effect.as("auto" as const)),
  ),
);
