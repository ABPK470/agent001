import {
  Agent,
  detectInternalFailure,
  EventType,
  fillRunReference,
  isPlatformUnconfiguredAnswer,
  mapFailureKindForPolish,
  markPolishedFailure,
  polishFailureForUser,
  spawnChildForPlan,
  synthesizeGenericFailureAnswer,
  type ToolKillManager
} from "@mia/agent"
import { broadcast, broadcastTrace } from "../../../../platform/events/broadcaster.js"
import * as db from "../../../../platform/persistence/sqlite.js"
import { TrajectoryEventKind } from "../../../../shared/enums/trajectory.js"
import { handlePlannerTrace } from "../../core/coordination/planner-events.js"
import { persistToolResult } from "../tool-result-persister.js"
import type { ExecuteRunCommand, ExecutionEnvironment } from "./types.js"

function createKillManager(
  command: ExecuteRunCommand,
  env: Pick<ExecutionEnvironment, "runContext">
): ToolKillManager {
  const { request, runtime } = command
  const callSignals = new Map<string, AbortSignal>()
  return {
    register: (toolCallId: string, toolName: string) => {
      const perToolCtrl = new AbortController()
      const composed = AbortSignal.any([runtime.controller.signal, perToolCtrl.signal])
      callSignals.set(toolCallId, composed)
      env.runContext.signal = composed
      return new Promise<string>((resolve) => {
        const key = `${request.runId}:${toolCallId}`
        runtime.interaction.registerPendingKill(key, { resolve, perToolCtrl })
        broadcast({
          type: EventType.ToolCallExecuting,
          data: { runId: request.runId, toolCallId, toolName }
        })
      })
    },
    unregister: (toolCallId: string) => {
      callSignals.delete(toolCallId)
      runtime.interaction.clearPendingKill(`${request.runId}:${toolCallId}`)
      env.runContext.signal = runtime.controller.signal
      broadcast({ type: EventType.ToolCallCompleted, data: { runId: request.runId, toolCallId } })
    },
    wrap: async <T>(toolCallId: string, fn: () => Promise<T>): Promise<T> => {
      void toolCallId
      return await fn()
    }
  }
}

export function createRunAgent(command: ExecuteRunCommand, env: ExecutionEnvironment): Agent {
  const { request, runtime, sideEffects } = command
  const killManager = createKillManager(command, env)
  const agent = new Agent(runtime.interaction.llm, env.allTools, {
    verbose: true,
    signal: runtime.controller.signal,
    systemMessages: env.systemMessages,
    toolKillManager: killManager,
    enablePlanner: true,
    workspaceRoot: env.runWorkspace.executionRoot,
    onPlannerTrace: (entry) =>
      handlePlannerTrace(entry, {
        runId: request.runId,
        services: {
          runRepo: sideEffects.runRepo,
          auditService: sideEffects.auditLog,
          policyEvaluator: sideEffects.policyEvaluator,
          learner: sideEffects.learner,
          eventBus: sideEffects.eventBus
        },
        debugSeqRef: env.debugSeqRef,
        saveTrace: env.boundSaveTrace
      }),
    plannerDelegateFn: (step, envelope) => spawnChildForPlan(env.delegateCtx, step, envelope),
    onNudge: (data) => {
      const entry = {
        kind: "nudge" as const,
        tag: data.tag,
        message: data.message,
        iteration: data.iteration
      }
      env.boundSaveTrace(request.runId, entry)
      broadcastTrace(request.runId, env.debugSeqRef.value++, entry)
    },
    onToolResult: (data) => {
      persistToolResult({
        runId: request.runId,
        sessionId: env.activeRun?.sessionId ?? null,
        upn: env.activeRun?.ownerUpn ?? null,
        goal: request.goal,
        iteration: data.iteration,
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        args: data.args,
        result: data.result,
        isError: data.isError
      })
    },
    onLlmCall: (data) => {
      if (data.phase === "request") {
        const entry = {
          kind: TrajectoryEventKind.LlmRequest,
          iteration: data.iteration,
          messageCount: data.messages.length,
          toolCount: data.tools.length,
          messages: data.messages.map((message) => ({
            role: message.role,
            content: message.content,
            toolCalls:
              message.toolCalls?.map((toolCall) => ({
                id: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments
              })) ?? [],
            toolCallId: message.toolCallId ?? null
          }))
        }
        env.boundSaveTrace(request.runId, entry)
        broadcastTrace(request.runId, env.debugSeqRef.value++, entry)
        return
      }

      const entry = {
        kind: TrajectoryEventKind.LlmResponse,
        iteration: data.iteration,
        durationMs: data.durationMs,
        content: data.response.content,
        toolCalls: data.response.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments
        })),
        usage: data.response.usage ?? null
      }
      env.boundSaveTrace(request.runId, entry)
      broadcastTrace(request.runId, env.debugSeqRef.value++, entry)
    },
    onThinking: (content, _toolCalls, iteration) => {
      const iterEntry = { kind: TrajectoryEventKind.Iteration, current: iteration + 1, max: 30 }
      env.boundSaveTrace(request.runId, iterEntry)
      broadcastTrace(request.runId, env.debugSeqRef.value++, iterEntry)
      if (content) {
        env.boundSaveTrace(request.runId, { kind: TrajectoryEventKind.Thinking, text: content })
        broadcast({ type: EventType.AgentThinking, data: { runId: request.runId, content, iteration } })
      }
      const currentAgent = agent
      const iterationTokens = currentAgent.usage.totalTokens - env.progress.prevTotalTokens
      env.progress.prevTotalTokens = currentAgent.usage.totalTokens
      const usageEntry = {
        kind: TrajectoryEventKind.Usage,
        iterationTokens,
        totalTokens: currentAgent.usage.totalTokens,
        promptTokens: currentAgent.usage.promptTokens,
        completionTokens: currentAgent.usage.completionTokens,
        llmCalls: currentAgent.llmCalls
      }
      env.boundSaveTrace(request.runId, usageEntry)
      broadcastTrace(request.runId, env.debugSeqRef.value++, usageEntry)
      broadcast({
        type: EventType.UsageUpdated,
        data: {
          runId: request.runId,
          promptTokens: currentAgent.usage.promptTokens,
          completionTokens: currentAgent.usage.completionTokens,
          totalTokens: currentAgent.usage.totalTokens,
          llmCalls: currentAgent.llmCalls
        }
      })
    },
    onStep: async (messages, iteration) => {
      env.progress.lastMessages = messages
      env.progress.lastIteration = iteration
      db.saveCheckpoint({
        run_id: request.runId,
        messages: JSON.stringify(messages),
        iteration,
        step_counter: env.state.stepCounter,
        updated_at: new Date().toISOString()
      })
      broadcast({
        type: EventType.CheckpointSaved,
        data: { runId: request.runId, iteration, stepCounter: env.state.stepCounter }
      })
      env.persistCurrentRun()
    },
    onToken: (token) => {
      broadcast({ type: EventType.AnswerChunk, data: { runId: request.runId, chunk: token } })
    },
    onStreamDiscard: () => {
      broadcast({ type: EventType.StreamReset, data: { runId: request.runId } })
    }
  })

  return agent
}

export async function normalizeRunAnswer(
  command: ExecuteRunCommand,
  env: ExecutionEnvironment,
  answer: string
): Promise<string> {
  const { request, runtime, sideEffects } = command
  let nextAnswer = answer

  if (isPlatformUnconfiguredAnswer(nextAnswer)) {
    const polished = await polishFailureForUser(
      runtime.interaction.llm,
      {
        goal: request.goal,
        operatorSummary: "A required backend integration is not configured on this server.",
        failureKind: "platform_unconfigured",
        runRef: request.runId
      },
      { signal: runtime.controller.signal }
    )
    nextAnswer = polished ? markPolishedFailure(polished) : fillRunReference(nextAnswer, request.runId)
  }

  const internalFailure = detectInternalFailure(nextAnswer)
  if (!internalFailure) return nextAnswer

  const truncatedRaw = internalFailure.rawDetail.slice(0, 4000)
  try {
    db.saveLog({
      run_id: request.runId,
      level: "run:error",
      message: `[user-safe-failure] ${internalFailure.kind} — ${internalFailure.summary}\n${truncatedRaw}`,
      timestamp: new Date().toISOString()
    })
  } catch {
    // Log persistence is best-effort.
  }

  try {
    await sideEffects.auditLog.log({
      actor: env.actor,
      action: "agent.user_safe_failure",
      resourceType: "AgentRun",
      resourceId: request.runId,
      detail: { kind: internalFailure.kind, summary: internalFailure.summary, raw: truncatedRaw }
    })
  } catch {
    // Audit logging is best-effort.
  }

  try {
    broadcast({
      type: EventType.RunUserSafeFailure,
      data: { runId: request.runId, kind: internalFailure.kind, summary: internalFailure.summary }
    })
  } catch {
    // Broadcasting is best-effort.
  }

  console.error(
    `[run-executor] Internal failure for run ${request.runId} (${internalFailure.kind}): ${internalFailure.summary}`
  )
  const polished = await polishFailureForUser(
    runtime.interaction.llm,
    {
      goal: request.goal,
      operatorSummary: internalFailure.summary,
      failureKind: mapFailureKindForPolish(internalFailure.kind),
      runRef: request.runId
    },
    { signal: runtime.controller.signal }
  )
  return polished
    ? markPolishedFailure(polished)
    : fillRunReference(synthesizeGenericFailureAnswer(), request.runId)
}
