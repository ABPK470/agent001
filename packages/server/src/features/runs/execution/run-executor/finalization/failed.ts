import { EventType, failRunPure, runFailed, type Agent } from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { broadcast } from "../../../../../platform/events/broadcaster.js"
import { ingestRunTurns } from "../../../../../platform/persistence/memory.js"
import * as db from "../../../../../platform/persistence/sqlite.js"
import { NotificationActionType } from "../../../../../shared/enums/notifications.js"
import { TrajectoryEventKind } from "../../../../../shared/enums/trajectory.js"
import { persistAuditLog, persistTokenUsage } from "../../persistence.js"
import { buildPersistedToolTrace } from "../support.js"
import type { ExecuteRunCommand, ExecutionEnvironment } from "../types.js"

function saveFailureCheckpoint(command: ExecuteRunCommand, env: ExecutionEnvironment): void {
  const { request } = command
  if (env.progress.lastMessages.length === 0) return

  db.saveCheckpoint({
    run_id: request.runId,
    messages: JSON.stringify(env.progress.lastMessages),
    iteration: env.progress.lastIteration,
    step_counter: env.state.stepCounter,
    updated_at: new Date().toISOString()
  })
  broadcast({
    type: EventType.CheckpointSaved,
    data: {
      runId: request.runId,
      iteration: env.progress.lastIteration,
      stepCounter: env.state.stepCounter
    }
  })
}

export async function finalizeFailedRun(
  command: ExecuteRunCommand,
  env: ExecutionEnvironment,
  agent: Agent,
  error: unknown
): Promise<void> {
  const { request, runtime, sideEffects } = command
  const errMsg = error instanceof Error ? error.message : String(error)
  const persistedToolTrace = buildPersistedToolTrace(env.state.run.steps)
  env.state.run = failRunPure(env.state.run)
  await sideEffects.eventBus.publish(runFailed(env.state.run.id, errMsg))
  await sideEffects.auditLog.log({
    actor: env.actor,
    action: "agent.failed",
    resourceType: "AgentRun",
    resourceId: env.state.run.id,
    detail: {
      goal: request.goal,
      error: errMsg,
      totalTokens: agent.usage.totalTokens,
      promptTokens: agent.usage.promptTokens,
      completionTokens: agent.usage.completionTokens,
      llmCalls: agent.llmCalls
    }
  })

  saveFailureCheckpoint(command, env)

  env.persistCurrentRun(undefined, errMsg)
  await persistAuditLog(sideEffects.auditLog, request.runId)
  persistTokenUsage(request.runId, agent)
  env.boundSaveTrace(request.runId, { kind: TrajectoryEventKind.Error, text: errMsg })
  await runtime.workspaceStore.captureOutputDiff(
    request.runId,
    env.boundSaveTrace,
    sideEffects.notifications.notify
  )
  ingestRunTurns({
    id: request.runId,
    goal: request.goal,
    answer: null,
    status: RunStatus.Failed,
    agentId: request.agentId,
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
      runId: request.runId,
      error: errMsg,
      stepCount: env.state.run.steps.length,
      totalTokens: agent.usage.totalTokens,
      promptTokens: agent.usage.promptTokens,
      completionTokens: agent.usage.completionTokens,
      llmCalls: agent.llmCalls
    }
  })
  db.saveLog({
    run_id: request.runId,
    level: "run:error",
    message: `Failed — ${errMsg.slice(0, 200)}`,
    timestamp: new Date().toISOString()
  })
  const hasCheckpoint = !!db.getCheckpoint(request.runId)
  sideEffects.notifications.notify({
    type: EventType.RunFailed,
    title: "Run failed",
    message: `"${request.goal.slice(0, 80)}" failed: ${errMsg.slice(0, 120)}`,
    runId: request.runId,
    actions: [
      { label: "Review", action: NotificationActionType.ViewRun, data: { runId: request.runId } },
      ...(hasCheckpoint
        ? [
            {
              label: "Resume",
              action: NotificationActionType.ResumeRun,
              data: { runId: request.runId }
            }
          ]
        : []),
      { label: "Rollback", action: NotificationActionType.RollbackRun, data: { runId: request.runId } }
    ]
  })
}
