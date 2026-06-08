import { completeRunPure, EventType, isUserSafeFailureAnswer, runCompleted, type Agent } from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { broadcast } from "../../../../../platform/events/broadcaster.js"
import { consolidate, extractProcedural, ingestRunTurns } from "../../../../../platform/persistence/memory.js"
import * as db from "../../../../../platform/persistence/sqlite.js"
import { NotificationActionType } from "../../../../../shared/enums/notifications.js"
import { TrajectoryEventKind } from "../../../../../shared/enums/trajectory.js"
import { createNotification, persistAuditLog, persistTokenUsage } from "../../persistence.js"
import { captureRunWorkspaceDiff } from "../../workspace-effects.js"
import { buildPersistedToolTrace } from "../support.js"
import type { ExecuteRunInput, ExecutionEnvironment } from "../types.js"

function hasInternalTaskFailure(answer: string): boolean {
  return (
    answer.startsWith("Task FAILED") ||
    answer.startsWith("Task verification FAILED") ||
    isUserSafeFailureAnswer(answer)
  )
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
  const taskInternallyFailed = hasInternalTaskFailure(answer)

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
