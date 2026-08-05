export function normalizeApprovalDeniedReason(reason?: string | null): string {
  return reason?.trim() ?? ""
}

export function formatApprovalWaitLabel(toolName: string, reason: string): string {
  return reason
    ? `Paused for approval — ${toolName}: ${reason}`
    : `Paused for approval — ${toolName}`
}

export function formatApprovalDeniedLabel(
  toolName: string,
  reason?: string | null,
): string {
  const normalizedReason = normalizeApprovalDeniedReason(reason)
  return normalizedReason
    ? `Approval denied — ${toolName}: ${normalizedReason}`
    : `Approval denied — ${toolName}`
}

export function formatApprovalDeniedCancelDetail(
  toolName: string,
  reason?: string | null,
): string {
  const normalizedReason = normalizeApprovalDeniedReason(reason)
  return normalizedReason
    ? `Tool approval denied for ${toolName}: ${normalizedReason}`
    : `Tool approval denied for ${toolName}.`
}
