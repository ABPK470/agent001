import { Agent, detectInternalFailure, EventType, fillRunReference, isPlatformUnconfiguredAnswer, mapFailureKindForPolish, markPolishedFailure, polishFailureForUser, spawnChildForPlan, synthesizeGenericFailureAnswer, type ToolKillManager } from "@mia/agent"
import * as db from "../../../../adapters/persistence/sqlite.js"
import { TrajectoryEventKind } from "../../../../enums/trajectory.js"
import { broadcast, broadcastTrace } from "../../../../event-broadcaster.js"
import { handlePlannerTrace } from "../../../core/coordination/planner-events.js"
import { persistToolResult } from "../tool-result-persister.js"
import type { ExecuteRunInput, ExecutionEnvironment } from "./types.js"

function createKillManager(input: ExecuteRunInput, env: Pick<ExecutionEnvironment, "runContext">): ToolKillManager {
  const callSignals = new Map<string, AbortSignal>()
  return {
    register: (toolCallId: string, toolName: string) => {
      const perToolCtrl = new AbortController()
      const composed = AbortSignal.any([input.controller.signal, perToolCtrl.signal])
      callSignals.set(toolCallId, composed)
      env.runContext.signal = composed
      return new Promise<string>((resolve) => {
        const key = `${input.runId}:${toolCallId}`
        input.ctx.pendingKills.set(key, { resolve, perToolCtrl })
        broadcast({ type: EventType.ToolCallExecuting, data: { runId: input.runId, toolCallId, toolName } })
      })
    },
    unregister: (toolCallId: string) => {
      callSignals.delete(toolCallId)
      input.ctx.pendingKills.delete(`${input.runId}:${toolCallId}`)
      env.runContext.signal = input.controller.signal
      broadcast({ type: EventType.ToolCallCompleted, data: { runId: input.runId, toolCallId } })
    },
    wrap: async <T,>(toolCallId: string, fn: () => Promise<T>): Promise<T> => {
      void toolCallId
      return await fn()
    },
  }
}

export function createRunAgent(input: ExecuteRunInput, env: ExecutionEnvironment): Agent {
  const killManager = createKillManager(input, env)
  const agent = new Agent(input.ctx.llm, env.allTools, {
    verbose: true,
    signal: input.controller.signal,
    systemMessages: env.systemMessages,
    toolKillManager: killManager,
    enablePlanner: true,
    workspaceRoot: env.runWorkspace.executionRoot,
    onPlannerTrace: (entry) => handlePlannerTrace(entry, { runId: input.runId, services: input.services, debugSeqRef: env.debugSeqRef, saveTrace: env.boundSaveTrace }),
    plannerDelegateFn: (step, envelope) => spawnChildForPlan(env.delegateCtx, step, envelope),
    onNudge: (data) => {
      const entry = { kind: "nudge" as const, tag: data.tag, message: data.message, iteration: data.iteration }
      env.boundSaveTrace(input.runId, entry)
      broadcastTrace(input.runId, env.debugSeqRef.value++, entry)
    },
    onToolResult: (data) => {
      persistToolResult({
        runId: input.runId,
        sessionId: env.activeRun?.sessionId ?? null,
        upn: env.activeRun?.ownerUpn ?? null,
        goal: input.goal,
        iteration: data.iteration,
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        args: data.args,
        result: data.result,
        isError: data.isError,
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
            toolCalls: message.toolCalls?.map((toolCall) => ({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments })) ?? [],
            toolCallId: message.toolCallId ?? null,
          })),
        }
        env.boundSaveTrace(input.runId, entry)
        broadcastTrace(input.runId, env.debugSeqRef.value++, entry)
        return
      }

      const entry = {
        kind: TrajectoryEventKind.LlmResponse,
        iteration: data.iteration,
        durationMs: data.durationMs,
        content: data.response.content,
        toolCalls: data.response.toolCalls.map((toolCall) => ({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments })),
        usage: data.response.usage ?? null,
      }
      env.boundSaveTrace(input.runId, entry)
      broadcastTrace(input.runId, env.debugSeqRef.value++, entry)
    },
    onThinking: (content, _toolCalls, iteration) => {
      const iterEntry = { kind: TrajectoryEventKind.Iteration, current: iteration + 1, max: 30 }
      env.boundSaveTrace(input.runId, iterEntry)
      broadcastTrace(input.runId, env.debugSeqRef.value++, iterEntry)
      if (content) {
        env.boundSaveTrace(input.runId, { kind: TrajectoryEventKind.Thinking, text: content })
        broadcast({ type: EventType.AgentThinking, data: { runId: input.runId, content, iteration } })
      }
      const currentAgent = env.agentRef.current
      if (!currentAgent) return
      const iterationTokens = currentAgent.usage.totalTokens - env.progress.prevTotalTokens
      env.progress.prevTotalTokens = currentAgent.usage.totalTokens
      const usageEntry = {
        kind: TrajectoryEventKind.Usage,
        iterationTokens,
        totalTokens: currentAgent.usage.totalTokens,
        promptTokens: currentAgent.usage.promptTokens,
        completionTokens: currentAgent.usage.completionTokens,
        llmCalls: currentAgent.llmCalls,
      }
      env.boundSaveTrace(input.runId, usageEntry)
      broadcastTrace(input.runId, env.debugSeqRef.value++, usageEntry)
      broadcast({ type: EventType.UsageUpdated, data: { runId: input.runId, promptTokens: currentAgent.usage.promptTokens, completionTokens: currentAgent.usage.completionTokens, totalTokens: currentAgent.usage.totalTokens, llmCalls: currentAgent.llmCalls } })
    },
    onStep: async (messages, iteration) => {
      env.progress.lastMessages = messages
      env.progress.lastIteration = iteration
      db.saveCheckpoint({ run_id: input.runId, messages: JSON.stringify(messages), iteration, step_counter: env.state.stepCounter, updated_at: new Date().toISOString() })
      broadcast({ type: EventType.CheckpointSaved, data: { runId: input.runId, iteration, stepCounter: env.state.stepCounter } })
      env.persistCurrentRun()
    },
    onToken: (token) => {
      broadcast({ type: EventType.AnswerChunk, data: { runId: input.runId, chunk: token } })
    },
    onStreamDiscard: () => {
      broadcast({ type: EventType.StreamReset, data: { runId: input.runId } })
    },
  })

  env.agentRef.current = agent
  return agent
}

export async function normalizeRunAnswer(input: ExecuteRunInput, env: ExecutionEnvironment, answer: string): Promise<string> {
  let nextAnswer = answer

  if (isPlatformUnconfiguredAnswer(nextAnswer)) {
    const polished = await polishFailureForUser(input.ctx.llm, {
      goal: input.goal,
      operatorSummary: "A required backend integration is not configured on this server.",
      failureKind: "platform_unconfigured",
      runRef: input.runId,
    }, { signal: input.controller.signal })
    nextAnswer = polished ? markPolishedFailure(polished) : fillRunReference(nextAnswer, input.runId)
  }

  const internalFailure = detectInternalFailure(nextAnswer)
  if (!internalFailure) return nextAnswer

  const truncatedRaw = internalFailure.rawDetail.slice(0, 4000)
  try {
    db.saveLog({
      run_id: input.runId,
      level: "run:error",
      message: `[user-safe-failure] ${internalFailure.kind} — ${internalFailure.summary}\n${truncatedRaw}`,
      timestamp: new Date().toISOString(),
    })
  } catch {
    // Log persistence is best-effort.
  }

  try {
    await input.services.auditService.log({
      actor: env.actor,
      action: "agent.user_safe_failure",
      resourceType: "AgentRun",
      resourceId: input.runId,
      detail: { kind: internalFailure.kind, summary: internalFailure.summary, raw: truncatedRaw },
    })
  } catch {
    // Audit logging is best-effort.
  }

  try {
    broadcast({ type: EventType.RunUserSafeFailure, data: { runId: input.runId, kind: internalFailure.kind, summary: internalFailure.summary } })
  } catch {
    // Broadcasting is best-effort.
  }

  console.error(`[run-executor] Internal failure for run ${input.runId} (${internalFailure.kind}): ${internalFailure.summary}`)
  const polished = await polishFailureForUser(input.ctx.llm, {
    goal: input.goal,
    operatorSummary: internalFailure.summary,
    failureKind: mapFailureKindForPolish(internalFailure.kind),
    runRef: input.runId,
  }, { signal: input.controller.signal })
  return polished ? markPolishedFailure(polished) : fillRunReference(synthesizeGenericFailureAnswer(), input.runId)
}