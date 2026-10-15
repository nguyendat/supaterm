import {
  CommandId,
  type OrchestrationV2ConversationMessage,
  type ThreadId,
} from "@supaterm/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MAX_HISTORY_CHARS = 32_000;
const MAX_SUMMARY_CHARS = 700;
const MAX_NEXT_ACTION_CHARS = 200;

export class ThreadRecapGenerationService extends Context.Service<
  ThreadRecapGenerationService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("supaterm/orchestration-v2/ThreadRecapGenerationService") {}

export function formatThreadRecapContext(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): string {
  const blocks = messages.flatMap((message) => {
    if (
      (message.role !== "user" && message.role !== "assistant") ||
      message.createdBy === "system" ||
      message.streaming ||
      message.text.trim().length === 0
    ) {
      return [];
    }
    return [`${message.role === "user" ? "User" : "Assistant"}: ${message.text.trim()}`];
  });
  const history = blocks.join("\n\n");
  if (history.length <= MAX_HISTORY_CHARS) return history;
  return `[Earlier exchanges omitted]\n\n${history.slice(-MAX_HISTORY_CHARS)}`;
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const complete = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly summary?: string;
    readonly nextAction?: string;
  }) =>
    threads
      .dispatch({
        type: "thread.recap.complete",
        commandId: CommandId.make(`${input.requestId}:recap-complete`),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.nextAction === undefined ? {} : { nextAction: input.nextAction }),
      })
      .pipe(Effect.asVoid);

  const execute: ThreadRecapGenerationService["Service"]["execute"] = Effect.fn(
    "ThreadRecapGenerationService.execute",
  )(function* (input) {
    const outcome:
      | {
          readonly type: "stale";
        }
      | {
          readonly type: "complete";
          readonly summary?: string;
          readonly nextAction?: string;
        } = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(input.threadId, ["messages"]);
      if (projection.thread.recapGeneration?.requestId !== input.requestId) {
        return { type: "stale" as const };
      }
      const history = formatThreadRecapContext(projection.messages);
      if (history.length === 0) return { type: "complete" as const };
      const project = yield* projects.get(projection.thread.projectId);
      if (Option.isNone(project)) return { type: "complete" as const };
      const result = yield* textGeneration.generateRecap({
        cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
        history,
        modelSelection: projection.thread.modelSelection,
      });
      const summary = result.summary.trim().slice(0, MAX_SUMMARY_CHARS);
      if (summary.length === 0) return { type: "complete" as const };
      return {
        type: "complete" as const,
        summary,
        ...(result.nextAction?.trim()
          ? { nextAction: result.nextAction.trim().slice(0, MAX_NEXT_ACTION_CHARS) }
          : {}),
      };
    }).pipe(
      Effect.retry({ times: 1, schedule: Schedule.exponential("2 seconds") }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread recap generation failed", {
              threadId: input.threadId,
              requestId: input.requestId,
              cause,
            }).pipe(Effect.as({ type: "complete" as const })),
      ),
    );

    if (outcome.type === "stale") return;
    yield* complete({
      threadId: input.threadId,
      requestId: input.requestId,
      ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
      ...(outcome.nextAction === undefined ? {} : { nextAction: outcome.nextAction }),
    });
  });

  return ThreadRecapGenerationService.of({ execute });
});

export const layer = Layer.effect(ThreadRecapGenerationService, make);
