/** Live + hydrated state for the approval-required modal. */

export interface PendingToolApproval {
  approvalId: string | null
  runId: string
  stepId: string
  toolName: string
  reason: string
  policyName?: string
  args?: Record<string, unknown>
  notificationId?: string | null
}

export type ActionableToolApproval =
  Omit<PendingToolApproval, "approvalId"> & { approvalId: string }

type NotificationActionLike = {
  action: string
  data?: Record<string, unknown>
}

type ApprovalNotificationLike = {
  id: string
  runId: string | null
  stepId: string | null
  actions: NotificationActionLike[]
}

function stringField(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key]
  return typeof value === "string" && value ? value : undefined
}

function recordField(
  data: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = data[key]
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Approve/deny action payload carries structured approval fields (not message text). */
function approvalFieldsFromNotificationActions(
  actions: readonly NotificationActionLike[],
): {
  approvalId: string
  toolName: string
  reason: string
  policyName?: string
} | null {
  const action =
    actions.find((a) => a.action === "approve-run-step" || a.action === "deny-run-step")
    ?? null
  const data = action?.data
  const approvalId = stringField(data, "approvalId")
  const toolName = stringField(data, "toolName")
  const reason = stringField(data, "reason")
  if (!approvalId || !toolName || !reason) return null

  const policyName = stringField(data, "policyName")
  return {
    approvalId,
    toolName,
    reason,
    ...(policyName ? { policyName } : {}),
  }
}

export function pendingApprovalFromEvent(
  data: Record<string, unknown>,
): PendingToolApproval | null {
  const runId = stringField(data, "runId")
  const stepId = stringField(data, "stepId")
  const toolName = stringField(data, "toolName")
  const reason = stringField(data, "reason")
  if (!runId || !stepId || !toolName || !reason) return null

  const policyName = stringField(data, "policyName")
  const args = recordField(data, "args")
  return {
    approvalId: stringField(data, "approvalId") ?? null,
    runId,
    stepId,
    toolName,
    reason,
    ...(policyName ? { policyName } : {}),
    ...(args ? { args } : {}),
    notificationId: null,
  }
}

/** Build pending-approval state from a persisted/live notification row. */
export function pendingApprovalFromNotification(
  notification: ApprovalNotificationLike,
): ActionableToolApproval | null {
  if (!notification.runId) return null
  const fields = approvalFieldsFromNotificationActions(notification.actions)
  if (!fields) return null
  return {
    approvalId: fields.approvalId,
    runId: notification.runId,
    stepId: notification.stepId ?? "",
    toolName: fields.toolName,
    reason: fields.reason,
    ...(fields.policyName ? { policyName: fields.policyName } : {}),
    notificationId: notification.id,
  }
}
