/** Shared copy for tool-approval wait states in chat trace + collapse. */

export const WAITING_APPROVAL_RE = /^Waiting for approval\s*[—–-]\s*([^:]+):\s*(.*)$/i

export function parseApprovalWaitMessage(text: string): { tool: string; reason: string } | null {
  const match = WAITING_APPROVAL_RE.exec(text.trim())
  if (!match) return null
  return {
    tool: match[1]?.trim() || "tool",
    reason: match[2]?.trim() || "",
  }
}

export function formatApprovalWaitLabel(tool: string, reason: string): string {
  return reason
    ? `Paused for approval — ${tool}: ${reason}`
    : `Paused for approval — ${tool}`
}
