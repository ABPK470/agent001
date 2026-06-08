import { cancelRunPure, EventType, type Agent } from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { broadcast } from "../../../../../platform/events/broadcaster.js"
import * as db from "../../../../../platform/persistence/sqlite.js"
import { NotificationActionType } from "../../../../../shared/enums/notifications.js"
import { createNotification, persistAuditLog, persistTokenUsage } from "../../persistence.js"
import { captureRunWorkspaceDiff } from "../../workspace-effects.js"
import type { ExecuteRunInput, ExecutionEnvironment } from "../types.js"

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
