import { asRunId, EventType, failRunPure, runFailed, type Agent } from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { broadcast } from "../../../../infra/events/broadcaster.js"
import { ingestRunTurns } from "../../../../infra/persistence/memory.js"
import * as db from "../../../../infra/persistence/sqlite.js"
import { NotificationActionType } from "../../../../internal/enums/notifications.js"
import { TrajectoryEventKind } from "../../../../internal/enums/trajectory.js"
import { buildRunCapabilityActions } from "../../../run-capability-actions.js"
import { persistAuditLog, persistTokenUsage } from "../../persistence.js"
import { writeRunCheckpoint } from "../checkpoint-writer.js"
import { buildPersistedToolTrace } from "../support.js"
import type { ExecuteRunCommand, ExecutionEnvironment } from "../types.js"

/**
 * Persist a final failure checkpoint from the last live messages so a
 * crashed/timeout run is resumable. Delegates to the single checkpoint
 * writer; the empty-messages guard lives there.
 */
function saveFailureCheckpoint(command: ExecuteRunCommand, env: ExecutionEnvironment): void {
  writeRunCheckpoint({
    runId: command.request.runId,
    messages: env.progress.lastMessages,
    iteration: env.progress.lastIteration,
    stepCounter: env.state.stepCounter
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
  await sideEffects.eventBus.publish(runFailed(asRunId(env.state.run.id), errMsg))
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
  const ownerUpn = env.activeRun?.ownerUpn
  if (ownerUpn) {
    ingestRunTurns({
      id: request.runId,
      goal: request.goal,
      answer: null,
      status: RunStatus.Failed,
      tools: [...new Set(env.state.run.steps.map((step) => step.action))],
      stepCount: env.state.run.steps.length,
      error: errMsg,
      trace: persistedToolTrace,
      upn: ownerUpn
    })
  }
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
  sideEffects.notifications.notify({
    type: EventType.RunFailed,
    title: "Run failed",
    message: `"${request.goal.slice(0, 80)}" failed: ${errMsg.slice(0, 120)}`,
    runId: request.runId,
    actions: [
      { label: "Review", action: NotificationActionType.ViewRun, data: { runId: request.runId } },
      ...buildRunCapabilityActions(request.runId, RunStatus.Failed),
    ]
  })
}
