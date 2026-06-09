import { cancelRunPure, EventType, type Agent } from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { broadcast } from "../../../../../platform/events/broadcaster.js"
import * as db from "../../../../../platform/persistence/sqlite.js"
import { NotificationActionType } from "../../../../../shared/enums/notifications.js"
import { createNotification, persistAuditLog, persistTokenUsage } from "../../persistence.js"
import { captureRunWorkspaceDiff } from "../../workspace-effects.js"
import type { ExecuteRunCommand, ExecutionEnvironment } from "../types.js"

export async function finalizeCancelledRun(
  command: ExecuteRunCommand,
  env: ExecutionEnvironment,
  agent: Agent
): Promise<void> {
  const { request, runtime, sideEffects } = command
  env.state.run = cancelRunPure(env.state.run)
  await captureRunWorkspaceDiff(
    request.runId,
    runtime.orchestrator.activeRuns,
    runtime.orchestrator.completedRunWorkspaces,
    runtime.orchestrator.completedRunDiffs,
    env.boundSaveTrace,
    createNotification
  )
  await sideEffects.engine.auditService.log({
    actor: env.actor,
    action: "agent.cancelled",
    resourceType: "AgentRun",
    resourceId: env.state.run.id,
    detail: { goal: request.goal, totalTokens: agent.usage.totalTokens, llmCalls: agent.llmCalls }
  })
  env.persistCurrentRun()
  await persistAuditLog(sideEffects.engine, request.runId)
  persistTokenUsage(request.runId, agent)
  broadcast({
    type: EventType.RunCancelled,
    data: {
      runId: request.runId,
      status: RunStatus.Cancelled,
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
    message: "Cancelled",
    timestamp: new Date().toISOString()
  })
  createNotification({
    type: EventType.RunCancelled,
    title: "Run cancelled",
    message: `"${request.goal.slice(0, 80)}" was cancelled after ${env.state.run.steps.length} steps.`,
    runId: request.runId,
    actions: [
      { label: "View", action: NotificationActionType.ViewRun, data: { runId: request.runId } },
      { label: "Rollback", action: NotificationActionType.RollbackRun, data: { runId: request.runId } }
    ]
  })
}
