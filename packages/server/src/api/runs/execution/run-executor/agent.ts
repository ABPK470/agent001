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
import { broadcast, broadcastTrace } from "../../../../infra/events/broadcaster.js"
import * as db from "../../../../infra/persistence/sqlite.js"
import { TrajectoryEventKind } from "../../../../internal/enums/trajectory.js"
import { handlePlannerTrace } from "../../prompting/coordination/planner-events.js"
import { consumeMatchingToolGrant } from "../../application/run-tool-approval.js"
import { writeRunCheckpoint } from "./checkpoint-writer.js"
import { persistToolResult } from "../tool-result-persister.js"
import type { DelegateRuntimeContext, ExecuteRunCommand, ExecutionEnvironment } from "./types.js"

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

export function createChildUsageReporter(
  runId: string,
  resolveParentAgent: () => Agent | null
): DelegateRuntimeContext["reportChildUsage"] {
  const lastSeen = new WeakMap<object, { p: number; c: number; t: number; l: number }>()
  let totalPrompt = 0
  let totalCompletion = 0
  let totalTokens = 0
  let totalLlmCalls = 0

  return (childUsage, childLlmCalls) => {
    const prev = lastSeen.get(childUsage) ?? { p: 0, c: 0, t: 0, l: 0 }
    totalPrompt += childUsage.promptTokens - prev.p
    totalCompletion += childUsage.completionTokens - prev.c
    totalTokens += childUsage.totalTokens - prev.t
    totalLlmCalls += childLlmCalls - prev.l
    lastSeen.set(childUsage, {
      p: childUsage.promptTokens,
      c: childUsage.completionTokens,
      t: childUsage.totalTokens,
      l: childLlmCalls
    })

    const agent = resolveParentAgent()
    if (!agent) return

    agent.usage.promptTokens = totalPrompt
    agent.usage.completionTokens = totalCompletion
    agent.usage.totalTokens = totalTokens
    agent.llmCalls = totalLlmCalls
    broadcast({
      type: EventType.UsageUpdated,
      data: {
        runId,
        promptTokens: totalPrompt,
        completionTokens: totalCompletion,
        totalTokens,
        llmCalls: totalLlmCalls
      }
    })
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
        upn: env.activeRun?.ownerUpn ?? "",
        goal: request.goal,
        iteration: data.iteration,
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        args: data.args,
        result: data.result,
        isError: data.isError
      })
      if (!data.isError) {
        consumeMatchingToolGrant(
          request.runId,
          request.resume?.parentRunId ?? null,
          data.toolName,
          data.args as Record<string, unknown>
        )
      }
      // Tool-call-granular checkpoint: snapshot the live messages (which
      // already include this tool result) so resume picks up from THIS call
      // instead of from the last completed iteration. Keep `lastMessages`
      // current at the same granularity so the failure/approval finalizers
      // snapshot the right state if the run ends mid-iteration.
      env.progress.lastMessages = data.messages
      env.progress.lastIteration = data.iteration
      writeRunCheckpoint({
        runId: request.runId,
        messages: data.messages,
        iteration: data.iteration,
        stepCounter: env.state.stepCounter
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
      // End-of-iteration safety net: the guard-abort paths (circuit breaker,
      // forced abort round) append a system message without firing
      // `onToolResult`, so the per-tool-call checkpoint above would miss
      // them. This write covers that gap. In a normal iteration it is a
      // harmless no-op rewrite of the last tool-call checkpoint (same
      // messages, idempotent INSERT OR REPLACE).
      writeRunCheckpoint({
        runId: request.runId,
        messages,
        iteration,
        stepCounter: env.state.stepCounter
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
