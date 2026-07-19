import { completeRunPure, EventType, runCompleted, type Agent } from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { broadcast } from "../../../../../infra/events/broadcaster.js"
import { consolidate, ingestRunTurns } from "../../../../../infra/persistence/memory.js"
import { isInternalFailureAnswer } from "../../../../../infra/persistence/memory/episodic-quality.js"
import * as db from "../../../../../infra/persistence/sqlite.js"
import { NotificationActionType } from "../../../../../internal/enums/notifications.js"
import { TrajectoryEventKind } from "../../../../../internal/enums/trajectory.js"
import { buildRunCapabilityActions } from "../../../run-capability-actions.js"
import { persistAuditLog, persistTokenUsage } from "../../persistence.js"
import { buildPersistedToolTrace } from "../support.js"
import type { ExecuteRunCommand, ExecutionEnvironment } from "../types.js"

export async function finalizeCompletedRun(
  command: ExecuteRunCommand,
  env: ExecutionEnvironment,
  agent: Agent,
  answer: string
): Promise<void> {
  const { request, runtime, sideEffects } = command
  env.state.run = completeRunPure(env.state.run)
  await sideEffects.eventBus.publish(runCompleted(env.state.run.id))
  await sideEffects.auditLog.log({
    actor: env.actor,
    action: "agent.completed",
    resourceType: "AgentRun",
    resourceId: env.state.run.id,
    detail: {
      goal: request.goal,
      answer: answer.slice(0, 500),
      totalTokens: agent.usage.totalTokens,
      promptTokens: agent.usage.promptTokens,
      completionTokens: agent.usage.completionTokens,
      llmCalls: agent.llmCalls
    }
  })
  env.persistCurrentRun(answer)
  await persistAuditLog(sideEffects.auditLog, request.runId)
  persistTokenUsage(request.runId, agent)

  env.boundSaveTrace(request.runId, { kind: TrajectoryEventKind.Answer, text: answer })
  await runtime.workspaceStore.captureOutputDiff(
    request.runId,
    env.boundSaveTrace,
    sideEffects.notifications.notify
  )

  const pendingDiff = runtime.workspaceStore.getCompletedDiff(request.runId)
  const pendingChangeCount = pendingDiff
    ? pendingDiff.added.length + pendingDiff.modified.length + pendingDiff.deleted.length
    : 0
  const persistedToolTrace = buildPersistedToolTrace(env.state.run.steps)
  const taskInternallyFailed = isInternalFailureAnswer(answer)

  const ownerUpn = env.activeRun?.ownerUpn
  if (ownerUpn) {
    ingestRunTurns({
      id: request.runId,
      goal: request.goal,
      answer: taskInternallyFailed ? null : answer,
      status: taskInternallyFailed ? RunStatus.Failed : RunStatus.Completed,
      agentId: request.agentId,
      tools: [...new Set(env.state.run.steps.map((step) => step.action))],
      stepCount: env.state.run.steps.length,
      error: taskInternallyFailed ? answer.slice(0, 200) : undefined,
      trace: persistedToolTrace,
      upn: ownerUpn
    })
    consolidate({ minAgeHours: 24, upn: ownerUpn })
  }

  broadcast({
    type: EventType.RunCompleted,
    data: {
      runId: request.runId,
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
    run_id: request.runId,
    level: "run",
    message: `Completed — ${env.state.run.steps.length} steps`,
    timestamp: new Date().toISOString()
  })
  sideEffects.notifications.notify({
    type: EventType.RunCompleted,
    title: "Run completed",
    message:
      pendingChangeCount > 0
        ? `"${request.goal.slice(0, 80)}" finished with ${env.state.run.steps.length} steps. ${pendingChangeCount} workspace changes pending approval.`
        : `"${request.goal.slice(0, 80)}" finished with ${env.state.run.steps.length} steps.`,
    runId: request.runId,
    actions: [
      { label: "View", action: NotificationActionType.ViewRun, data: { runId: request.runId } },
      ...buildRunCapabilityActions(request.runId, RunStatus.Completed),
    ]
  })

  runtime.messaging.sendReply(request.runId, answer).catch((error) => {
    console.error(`Failed to send reply for run ${request.runId}:`, error)
  })
}
