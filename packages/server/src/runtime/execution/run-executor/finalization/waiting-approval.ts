import { ApprovalRequiredError, EventType, type Agent } from "@mia/agent"
import { RunStatus } from "@mia/shared-enums"
import { broadcast } from "../../../../infra/events/broadcaster.js"
import * as db from "../../../../infra/persistence/sqlite.js"
import { NotificationActionType } from "../../../../internal/enums/notifications.js"
import { TraceEventKind } from "../../../../internal/enums/trace.js"
import { createNotification, persistAuditLog, persistTokenUsage } from "../../persistence.js"
import { writeRunCheckpoint } from "../checkpoint-writer.js"
import type { ExecuteRunCommand, ExecutionEnvironment } from "../types.js"

/**
 * Persist a checkpoint from the last live messages so a run parked for
 * tool-approval is resumable. Delegates to the single checkpoint writer;
 * the empty-messages guard lives there.
 */
function saveWaitingCheckpoint(command: ExecuteRunCommand, env: ExecutionEnvironment): void {
  writeRunCheckpoint({
    runId: command.request.runId,
    messages: env.progress.lastMessages,
    iteration: env.progress.lastIteration,
    stepCounter: env.state.stepCounter
  })
}

export async function finalizeWaitingForApprovalRun(
  command: ExecuteRunCommand,
  env: ExecutionEnvironment,
  agent: Agent,
  error: ApprovalRequiredError
): Promise<void> {
  const { request, sideEffects } = command

  const approval = await db.upsertPendingRunToolApproval({
    runId: error.runId,
    stepId: error.stepId,
    toolName: error.toolName,
    args: error.args,
    reason: error.reason,
    policyName: error.policyName,
  })

  saveWaitingCheckpoint(command, env)

  await db.markRunWaitingForApproval(request.runId)
  env.state.run.status = RunStatus.WaitingForApproval
  await sideEffects.runRepo.save(env.state.run)
  env.persistCurrentRun(undefined, undefined)
  await persistAuditLog(sideEffects.auditLog, request.runId)
  persistTokenUsage(request.runId, agent)
  // Control-plane pause — never TraceEventKind.Error (that paints Fail in Trace).
  env.boundSaveTrace(request.runId, {
    kind: TraceEventKind.ApprovalWait,
    toolName: error.toolName,
    reason: error.reason.slice(0, 180),
    policyName: error.policyName,
  })

  await db.saveLog({
    run_id: request.runId,
    level: "run:warning",
    message: `Waiting for approval — ${error.toolName}: ${error.reason.slice(0, 180)}`,
    timestamp: new Date().toISOString(),
  })

  broadcast({
    type: EventType.ApprovalRequired,
    data: {
      runId: error.runId,
      stepId: error.stepId,
      toolName: error.toolName,
      reason: error.reason,
      policyName: error.policyName,
      approvalId: approval.id,
      args: error.args,
    },
  })

  const approvalActionData = {
    runId: error.runId,
    stepId: error.stepId,
    approvalId: approval.id,
    toolName: error.toolName,
    reason: error.reason,
    policyName: error.policyName,
  }
  await createNotification({
    type: EventType.ApprovalRequired,
    title: "Approval required",
    message: `Tool "${error.toolName}" needs approval: ${error.reason}`,
    runId: error.runId,
    stepId: error.stepId,
    actions: [
      {
        label: "Approve",
        action: NotificationActionType.ApproveRunStep,
        data: approvalActionData,
      },
      {
        label: "Deny",
        action: NotificationActionType.DenyRunStep,
        data: approvalActionData,
      },
      {
        label: "View run",
        action: NotificationActionType.ViewRun,
        data: { runId: error.runId },
      },
    ],
  })
}
