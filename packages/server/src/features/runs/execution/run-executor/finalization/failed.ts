import { EventType, failRunPure, runFailed, type Agent } from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { broadcast } from "../../../../../platform/events/broadcaster.js"
import { ingestRunTurns } from "../../../../../platform/persistence/memory.js"
import * as db from "../../../../../platform/persistence/sqlite.js"
import { NotificationActionType } from "../../../../../shared/enums/notifications.js"
import { TrajectoryEventKind } from "../../../../../shared/enums/trajectory.js"
import { createNotification, persistAuditLog, persistTokenUsage } from "../../persistence.js"
import { captureRunWorkspaceDiff } from "../../workspace-effects.js"
import { buildPersistedToolTrace } from "../support.js"
import type { ExecuteRunInput, ExecutionEnvironment } from "../types.js"

function saveFailureCheckpoint(input: ExecuteRunInput, env: ExecutionEnvironment): void {
  if (env.progress.lastMessages.length === 0) return

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

  saveFailureCheckpoint(input, env)

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
