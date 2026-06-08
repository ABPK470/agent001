import {
  cancelRunPure,
  completeRunPure,
  detectInternalFailure,
  EventType,
  failRunPure,
  isPlatformUnconfiguredAnswer,
  isUserSafeFailureAnswer,
  runCompleted,
  runFailed,
  type Agent
} from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { consolidate, extractProcedural, ingestRunTurns } from "../../../../adapters/persistence/memory.js"
import * as db from "../../../../adapters/persistence/sqlite.js"
import { NotificationActionType } from "../../../../enums/notifications.js"
import { TrajectoryEventKind } from "../../../../enums/trajectory.js"
import { broadcast } from "../../../../event-broadcaster.js"
import { runReflectionTurn } from "../../../core/coordination/run-reflection.js"
import { createNotification, persistAuditLog, persistTokenUsage } from "../persistence.js"
import { captureRunWorkspaceDiff } from "../workspace-effects.js"
import { buildPersistedToolTrace } from "./support.js"
import type { ExecuteRunInput, ExecutionEnvironment } from "./types.js"

export async function finalizeCancelledRun(
  input: ExecuteRunInput,
  env: ExecutionEnvironment,
  agent: Agent
): Promise<void> {
  env.state.run = cancelRunPure(env.state.run)
  await captureRunWorkspaceDiff(
    input.runId,
    input.ctx.activeRuns,
    input.ctx.completedRunWorkspaces,
    input.ctx.completedRunDiffs,
    env.boundSaveTrace,
    createNotification
  )
  await input.services.auditService.log({
    actor: env.actor,
    action: "agent.cancelled",
    resourceType: "AgentRun",
    resourceId: env.state.run.id,
    detail: { goal: input.goal, totalTokens: agent.usage.totalTokens, llmCalls: agent.llmCalls }
  })
  env.persistCurrentRun()
  await persistAuditLog(input.services, input.runId)
  persistTokenUsage(input.runId, agent)
  broadcast({
    type: EventType.RunCancelled,
    data: {
      runId: input.runId,
      status: RunStatus.Cancelled,
      stepCount: env.state.run.steps.length,
      totalTokens: agent.usage.totalTokens,
      promptTokens: agent.usage.promptTokens,
      completionTokens: agent.usage.completionTokens,
      llmCalls: agent.llmCalls
    }
  })
  db.saveLog({
    run_id: input.runId,
    level: "run:error",
    message: "Cancelled",
    timestamp: new Date().toISOString()
  })
  createNotification({
    type: EventType.RunCancelled,
    title: "Run cancelled",
    message: `"${input.goal.slice(0, 80)}" was cancelled after ${env.state.run.steps.length} steps.`,
    runId: input.runId,
    actions: [
      { label: "View", action: NotificationActionType.ViewRun, data: { runId: input.runId } },
      { label: "Rollback", action: NotificationActionType.RollbackRun, data: { runId: input.runId } }
    ]
  })
}

export async function maybeRunReflection(
  input: ExecuteRunInput,
  env: ExecutionEnvironment,
  answer: string
): Promise<void> {
  const internalFailure = detectInternalFailure(answer)
  if (!env.toolDecision.includeDataPersona || isPlatformUnconfiguredAnswer(answer) || !!internalFailure) {
    env.boundSaveTrace(input.runId, {
      kind: "reflection",
      outcome: "gated",
      verdictsRecorded: 0,
      toolResults: [],
      detail:
        `gate: includeDataPersona=${env.toolDecision.includeDataPersona ? 1 : 0} ` +
        `platformUnconfigured=${isPlatformUnconfiguredAnswer(answer) ? 1 : 0} ` +
        `internalFailure=${internalFailure ? 1 : 0}`
    })
    return
  }

  try {
    const verdictTool = env.allTools.find((tool) => tool.name === "record_table_verdict")
    if (!verdictTool) {
      env.boundSaveTrace(input.runId, {
        kind: "reflection",
        outcome: "skipped",
        verdictsRecorded: 0,
        toolResults: [],
        detail: "record_table_verdict tool not bound to this run"
      })
      return
    }

    const reflection = await runReflectionTurn({
      runId: input.runId,
      goal: input.goal,
      answer,
      steps: env.state.run.steps,
      recordVerdictTool: verdictTool,
      llm: input.ctx.llm,
      signal: input.controller.signal
    })
    console.log(
      `[reflection] run=${input.runId} outcome=${reflection.outcome} recorded=${reflection.verdictsRecorded} ${reflection.detail}`
    )
    env.boundSaveTrace(input.runId, {
      kind: "reflection",
      outcome: reflection.outcome,
      verdictsRecorded: reflection.verdictsRecorded,
      toolResults: reflection.toolResults,
      detail: reflection.detail
    })
  } catch (error) {
    console.warn(`[reflection] run=${input.runId} failed: ${(error as Error).message}`)
    env.boundSaveTrace(input.runId, {
      kind: "reflection",
      outcome: "error",
      verdictsRecorded: 0,
      toolResults: [],
      detail: `threw: ${(error as Error).message}`
    })
  }
}

export async function finalizeCompletedRun(
  input: ExecuteRunInput,
  env: ExecutionEnvironment,
  agent: Agent,
  answer: string
): Promise<void> {
  env.state.run = completeRunPure(env.state.run)
  await input.services.eventBus.publish(runCompleted(env.state.run.id))
  await input.services.auditService.log({
    actor: env.actor,
    action: "agent.completed",
    resourceType: "AgentRun",
    resourceId: env.state.run.id,
    detail: {
      goal: input.goal,
      answer: answer.slice(0, 500),
      totalTokens: agent.usage.totalTokens,
      promptTokens: agent.usage.promptTokens,
      completionTokens: agent.usage.completionTokens,
      llmCalls: agent.llmCalls
    }
  })
  env.persistCurrentRun(answer)
  await persistAuditLog(input.services, input.runId)
  persistTokenUsage(input.runId, agent)

  env.boundSaveTrace(input.runId, { kind: TrajectoryEventKind.Answer, text: answer })
  await captureRunWorkspaceDiff(
    input.runId,
    input.ctx.activeRuns,
    input.ctx.completedRunWorkspaces,
    input.ctx.completedRunDiffs,
    env.boundSaveTrace,
    createNotification
  )
  const pendingDiff = input.ctx.completedRunDiffs.get(input.runId)
  const pendingChangeCount = pendingDiff
    ? pendingDiff.added.length + pendingDiff.modified.length + pendingDiff.deleted.length
    : 0
  const persistedToolTrace = buildPersistedToolTrace(env.state.run.steps)
  const taskInternallyFailed =
    answer.startsWith("Task FAILED") ||
    answer.startsWith("Task verification FAILED") ||
    isUserSafeFailureAnswer(answer)

  ingestRunTurns({
    id: input.runId,
    goal: input.goal,
    answer: taskInternallyFailed ? null : answer,
    status: taskInternallyFailed ? RunStatus.Failed : RunStatus.Completed,
    agentId: input.agentId,
    sessionId: env.activeRun?.sessionId ?? null,
    tools: [...new Set(env.state.run.steps.map((step) => step.action))],
    stepCount: env.state.run.steps.length,
    error: taskInternallyFailed ? answer.slice(0, 200) : undefined,
    trace: persistedToolTrace,
    upn: env.activeRun?.ownerUpn ?? null
  })
  extractProcedural({
    id: input.runId,
    goal: input.goal,
    trace: persistedToolTrace,
    upn: env.activeRun?.ownerUpn ?? null,
    sessionId: env.activeRun?.sessionId ?? null
  })
  consolidate({ minAgeHours: 24, upn: env.activeRun?.ownerUpn ?? null })

  broadcast({
    type: EventType.RunCompleted,
    data: {
      runId: input.runId,
      answer,
      status: RunStatus.Completed,
      stepCount: env.state.run.steps.length,
      totalTokens: agent.usage.totalTokens,
      promptTokens: agent.usage.promptTokens,
      completionTokens: agent.usage.completionTokens,
      llmCalls: agent.llmCalls,
      pendingWorkspaceChanges: pendingChangeCount
    }
  })
  db.saveLog({
    run_id: input.runId,
    level: "run",
    message: `Completed — ${env.state.run.steps.length} steps`,
    timestamp: new Date().toISOString()
  })
  createNotification({
    type: EventType.RunCompleted,
    title: "Run completed",
    message:
      pendingChangeCount > 0
        ? `"${input.goal.slice(0, 80)}" finished with ${env.state.run.steps.length} steps. ${pendingChangeCount} workspace changes pending approval.`
        : `"${input.goal.slice(0, 80)}" finished with ${env.state.run.steps.length} steps.`,
    runId: input.runId,
    actions: [{ label: "View", action: NotificationActionType.ViewRun, data: { runId: input.runId } }]
  })

  if (input.ctx.messageRouter) {
    input.ctx.messageRouter.sendReply(input.runId, answer).catch((error) => {
      console.error(`Failed to send reply for run ${input.runId}:`, error)
    })
  }
}

export async function finalizeFailedRun(
  input: ExecuteRunInput,
  env: ExecutionEnvironment,
  agent: Agent,
  error: unknown
): Promise<void> {
  const errMsg = error instanceof Error ? error.message : String(error)
  const persistedToolTrace = buildPersistedToolTrace(env.state.run.steps)
  env.state.run = failRunPure(env.state.run)
  await input.services.eventBus.publish(runFailed(env.state.run.id, errMsg))
  await input.services.auditService.log({
    actor: env.actor,
    action: "agent.failed",
    resourceType: "AgentRun",
    resourceId: env.state.run.id,
    detail: {
      goal: input.goal,
      error: errMsg,
      totalTokens: agent.usage.totalTokens,
      promptTokens: agent.usage.promptTokens,
      completionTokens: agent.usage.completionTokens,
      llmCalls: agent.llmCalls
    }
  })

  if (env.progress.lastMessages.length > 0) {
    db.saveCheckpoint({
      run_id: input.runId,
      messages: JSON.stringify(env.progress.lastMessages),
      iteration: env.progress.lastIteration,
      step_counter: env.state.stepCounter,
      updated_at: new Date().toISOString()
    })
    broadcast({
      type: EventType.CheckpointSaved,
      data: {
        runId: input.runId,
        iteration: env.progress.lastIteration,
        stepCounter: env.state.stepCounter
      }
    })
  }

  env.persistCurrentRun(undefined, errMsg)
  await persistAuditLog(input.services, input.runId)
  persistTokenUsage(input.runId, agent)
  env.boundSaveTrace(input.runId, { kind: TrajectoryEventKind.Error, text: errMsg })
  await captureRunWorkspaceDiff(
    input.runId,
    input.ctx.activeRuns,
    input.ctx.completedRunWorkspaces,
    input.ctx.completedRunDiffs,
    env.boundSaveTrace,
    createNotification
  )
  ingestRunTurns({
    id: input.runId,
    goal: input.goal,
    answer: null,
    status: RunStatus.Failed,
    agentId: input.agentId,
    sessionId: env.activeRun?.sessionId ?? null,
    tools: [...new Set(env.state.run.steps.map((step) => step.action))],
    stepCount: env.state.run.steps.length,
    error: errMsg,
    trace: persistedToolTrace,
    upn: env.activeRun?.ownerUpn ?? null
  })
  broadcast({
    type: EventType.RunFailed,
    data: {
      runId: input.runId,
      error: errMsg,
      stepCount: env.state.run.steps.length,
      totalTokens: agent.usage.totalTokens,
      promptTokens: agent.usage.promptTokens,
      completionTokens: agent.usage.completionTokens,
      llmCalls: agent.llmCalls
    }
  })
  db.saveLog({
    run_id: input.runId,
    level: "run:error",
    message: `Failed — ${errMsg.slice(0, 200)}`,
    timestamp: new Date().toISOString()
  })
  const hasCheckpoint = !!db.getCheckpoint(input.runId)
  createNotification({
    type: EventType.RunFailed,
    title: "Run failed",
    message: `"${input.goal.slice(0, 80)}" failed: ${errMsg.slice(0, 120)}`,
    runId: input.runId,
    actions: [
      { label: "Review", action: NotificationActionType.ViewRun, data: { runId: input.runId } },
      ...(hasCheckpoint
        ? [
            {
              label: "Resume",
              action: NotificationActionType.ResumeRun,
              data: { runId: input.runId }
            }
          ]
        : []),
      { label: "Rollback", action: NotificationActionType.RollbackRun, data: { runId: input.runId } }
    ]
  })
}

export function cleanupExecution(
  input: ExecuteRunInput,
  env: ExecutionEnvironment | undefined,
  releaseSlot: () => void
): void {
  env?.disposeEventWiring()
  releaseSlot()
  input.bus.dispose()
  input.ctx.pendingInputs.delete(input.runId)
  input.ctx.activeRuns.delete(input.runId)
}
