import { cancelRunPure, EventType, type Agent } from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { broadcast } from "../../../../infra/events/broadcaster.js"
import * as db from "../../../../infra/persistence/sqlite.js"
import { NotificationActionType } from "../../../../internal/enums/notifications.js"
import { buildRunCapabilityActions } from "../../../run-capability-actions.js"
import { persistAuditLog, persistTokenUsage } from "../../persistence.js"
import type { ExecuteRunCommand, ExecutionEnvironment } from "../types.js"

export async function finalizeCancelledRun(
  command: ExecuteRunCommand,
  env: ExecutionEnvironment,
  agent: Agent
): Promise<void> {
  const { request, runtime, sideEffects } = command
  env.state.run = cancelRunPure(env.state.run)
  await runtime.workspaceStore.captureOutputDiff(
    request.runId,
    env.boundSaveTrace,
    sideEffects.notifications.notify
  )
  await sideEffects.auditLog.log({
    actor: env.actor,
    action: "agent.cancelled",
    resourceType: "AgentRun",
    resourceId: env.state.run.id,
    detail: { goal: request.goal, totalTokens: agent.usage.totalTokens, llmCalls: agent.llmCalls }
  })
  env.persistCurrentRun()
  await persistAuditLog(sideEffects.auditLog, request.runId)
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
  sideEffects.notifications.notify({
    type: EventType.RunCancelled,
    title: "Run cancelled",
    message: `"${request.goal.slice(0, 80)}" was cancelled after ${env.state.run.steps.length} steps.`,
    runId: request.runId,
    actions: [
      { label: "View", action: NotificationActionType.ViewRun, data: { runId: request.runId } },
      ...buildRunCapabilityActions(request.runId, RunStatus.Cancelled),
    ]
  })
}
