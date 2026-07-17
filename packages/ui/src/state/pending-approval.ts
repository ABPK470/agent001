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
