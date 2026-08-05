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

/** Approve/deny action payload carries structured approval fields (not message text). */
export function approvalFieldsFromNotificationActions(
  actions: readonly NotificationActionLike[],
): {
  approvalId: string | null
  toolName: string
  reason: string
  policyName?: string
} {
  const action =
    actions.find((a) => a.action === "approve-run-step" || a.action === "deny-run-step")
    ?? null
  const data = action?.data
  return {
    approvalId: stringField(data, "approvalId") ?? null,
    toolName: stringField(data, "toolName") ?? "unknown",
    reason: stringField(data, "reason") ?? "Policy requires approval",
    ...(stringField(data, "policyName")
      ? { policyName: stringField(data, "policyName") }
      : {}),
  }
}

/** Build a pending-approval record from an `approval.required` SSE payload. */
export function pendingApprovalFromEvent(data: Record<string, unknown>): PendingToolApproval {
  return {
    approvalId: (data["approvalId"] as string | undefined) ?? null,
    runId: data["runId"] as string,
    stepId: (data["stepId"] as string | undefined) ?? "",
    toolName: (data["toolName"] as string | undefined) ?? "unknown",
    reason: (data["reason"] as string | undefined) ?? "Policy requires approval",
    policyName: (data["policyName"] as string | undefined) ?? undefined,
    args: (data["args"] as Record<string, unknown> | undefined) ?? undefined,
    notificationId: null,
  }
}

/** Build pending-approval state from a persisted/live notification row. */
export function pendingApprovalFromNotification(
  notification: ApprovalNotificationLike,
): PendingToolApproval | null {
  if (!notification.runId) return null
  const fields = approvalFieldsFromNotificationActions(notification.actions)
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
