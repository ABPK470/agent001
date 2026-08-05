/** Shared copy for tool-approval wait / deny in chat + Trace projection. */

import type { TraceEntry } from "@mia/shared-types"
import { RunStatus } from "../enums"

export const WAITING_APPROVAL_RE = /^Waiting for approval\s*[—–-]\s*([^:]+):\s*(.*)$/i
export const APPROVAL_REQUIRED_RE = /^Approval required for tool "([^"]+)":\s*(.*)$/i
export const APPROVAL_DENIED_RE = /^Approval denied\s*[—–-]\s*([^:]+)(?::\s*(.*))?$/i

export function isApprovalWaitTraceText(text: string): boolean {
  const trimmed = text.trim()
  return WAITING_APPROVAL_RE.test(trimmed) || APPROVAL_REQUIRED_RE.test(trimmed)
}

export function isApprovalDeniedTraceText(text: string): boolean {
  return APPROVAL_DENIED_RE.test(text.trim())
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

export function parseApprovalDeniedMessage(text: string): { tool: string; reason: string } | null {
  const match = APPROVAL_DENIED_RE.exec(text.trim())
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

function meaningfulDenyReason(reason?: string | null): string {
  const r = reason?.trim() ?? ""
  if (!r || /^approval denied$/i.test(r)) return ""
  return r
}

/** Trace note — denial is cancellation, not failure. */
export function formatApprovalDeniedLabel(tool: string, reason?: string | null): string {
  const r = meaningfulDenyReason(reason)
  return r
    ? `Approval denied — ${tool}: ${r}`
    : `Approval denied — ${tool}`
}

/** Chat / RunStatus cancel reason line under "Run cancelled". */
export function formatApprovalDeniedCancelDetail(tool: string, reason?: string | null): string {
  const r = meaningfulDenyReason(reason)
  return r
    ? `Tool approval denied for ${tool}: ${r}`
    : `Tool approval denied for ${tool}.`
}

export function isApprovalDeniedCancelReason(text: string | null | undefined): boolean {
  if (!text) return false
  const t = text.toLowerCase()
  return t.includes("approval denied") || isApprovalDeniedTraceText(text)
}

/** Remove approval pause markers — modal owns the interactive wait UX. */
export function stripApprovalWaitTraceEntries(entries: readonly TraceEntry[]): TraceEntry[] {
  return entries.filter((entry) => {
    if (entry.kind !== "error" || !("text" in entry)) return true
    return !isApprovalWaitTraceText(entry.text)
  })
}

/** Denial markers are owned by the cancel terminal — not ErrorNote spam. */
export function stripApprovalDeniedTraceEntries(entries: readonly TraceEntry[]): TraceEntry[] {
  return entries.filter((entry) => {
    if (entry.kind !== "error" || !("text" in entry)) return true
    return !isApprovalDeniedTraceText(entry.text)
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

/**
 * Parked wait notes become a single denial cancel note — Trace must not
 * keep painting Fail/Error after the operator denied.
 */
export function rewriteApprovalWaitEntriesToDenied(
  entries: readonly TraceEntry[],
  toolName: string,
  reason?: string | null,
): TraceEntry[] {
  const deniedText = formatApprovalDeniedLabel(toolName, reason)
  let wrote = false
  const out: TraceEntry[] = []
  for (const entry of entries) {
    if (entry.kind === "error" && "text" in entry && isApprovalWaitTraceText(entry.text)) {
      if (!wrote) {
        out.push({ kind: "error", text: deniedText })
        wrote = true
      }
      continue
    }
    out.push(entry)
  }
  if (!wrote) {
    out.push({ kind: "error", text: deniedText })
  }
  return out
}

/** Chat transcript: pause while waiting; no wait/deny spam when settled. */
export function projectTraceForChatDisplay(
  entries: readonly TraceEntry[],
  runStatus: string,
): TraceEntry[] {
  if (runStatus === RunStatus.WaitingForApproval) {
    return keepLastApprovalWaitTraceEntry(entries)
  }
  return stripApprovalDeniedTraceEntries(stripApprovalWaitTraceEntries(entries))
}
