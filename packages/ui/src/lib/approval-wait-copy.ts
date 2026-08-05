/** Shared copy for tool-approval wait states in chat trace + collapse. */

import type { TraceEntry } from "@mia/shared-types"
import { RunStatus } from "../enums"

export const WAITING_APPROVAL_RE = /^Waiting for approval\s*[—–-]\s*([^:]+):\s*(.*)$/i
export const APPROVAL_REQUIRED_RE = /^Approval required for tool "([^"]+)":\s*(.*)$/i

export function isApprovalWaitTraceText(text: string): boolean {
  const trimmed = text.trim()
  return WAITING_APPROVAL_RE.test(trimmed) || APPROVAL_REQUIRED_RE.test(trimmed)
}

export function parseApprovalWaitMessage(text: string): { tool: string; reason: string } | null {
  const waiting = WAITING_APPROVAL_RE.exec(text.trim())
  if (waiting) {
    return {
      tool: waiting[1]?.trim() || "tool",
      reason: waiting[2]?.trim() || "",
    }
  }
  const required = APPROVAL_REQUIRED_RE.exec(text.trim())
  if (required) {
    return {
      tool: required[1]?.trim() || "tool",
      reason: required[2]?.trim() || "",
    }
  }
  return null
}

export function formatApprovalWaitLabel(tool: string, reason: string): string {
  return reason
    ? `Paused for approval — ${tool}: ${reason}`
    : `Paused for approval — ${tool}`
}

/** Remove approval pause markers — modal owns the interactive wait UX. */
export function stripApprovalWaitTraceEntries(entries: readonly TraceEntry[]): TraceEntry[] {
  return entries.filter((entry) => {
    if (entry.kind !== "error" || !("text" in entry)) return true
    return !isApprovalWaitTraceText(entry.text)
  })
}

/** While actively waiting, show at most one pause line (the latest). */
export function keepLastApprovalWaitTraceEntry(entries: readonly TraceEntry[]): TraceEntry[] {
  let lastIdx = -1
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.kind === "error" && "text" in entry && isApprovalWaitTraceText(entry.text)) {
      lastIdx = i
    }
  }
  if (lastIdx < 0) return [...entries]
  return entries.filter((entry, i) => {
    if (entry.kind !== "error" || !("text" in entry) || !isApprovalWaitTraceText(entry.text)) {
      return true
    }
    return i === lastIdx
  })
}

/** Chat transcript projection — no approval spam in history; one line while waiting. */
export function projectTraceForChatDisplay(
  entries: readonly TraceEntry[],
  runStatus: string,
): TraceEntry[] {
  if (runStatus === RunStatus.WaitingForApproval) {
    return keepLastApprovalWaitTraceEntry(entries)
  }
  return stripApprovalWaitTraceEntries(entries)
}
