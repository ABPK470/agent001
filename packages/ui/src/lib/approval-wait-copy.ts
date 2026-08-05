/**
 * Tool-approval control-plane notes — wire kinds only.
 * Wait = approval-wait. Deny = approval-denied. Never kind "error".
 */

import type { TraceEntry } from "@mia/shared-types"
import { RunStatus } from "../enums"

export function isApprovalWaitEntry(
  entry: TraceEntry,
): entry is Extract<TraceEntry, { kind: "approval-wait" }> {
  return entry.kind === "approval-wait"
}

export function isApprovalDeniedEntry(
  entry: TraceEntry,
): entry is Extract<TraceEntry, { kind: "approval-denied" }> {
  return entry.kind === "approval-denied"
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

export function formatApprovalDeniedLabel(tool: string, reason?: string | null): string {
  const r = meaningfulDenyReason(reason)
  return r
    ? `Approval denied — ${tool}: ${r}`
    : `Approval denied — ${tool}`
}

export function formatApprovalDeniedCancelDetail(tool: string, reason?: string | null): string {
  const r = meaningfulDenyReason(reason)
  return r
    ? `Tool approval denied for ${tool}: ${r}`
    : `Tool approval denied for ${tool}.`
}

export function stripApprovalWaitTraceEntries(entries: readonly TraceEntry[]): TraceEntry[] {
  return entries.filter((entry) => !isApprovalWaitEntry(entry))
}

export function stripApprovalDeniedTraceEntries(entries: readonly TraceEntry[]): TraceEntry[] {
  return entries.filter((entry) => !isApprovalDeniedEntry(entry))
}

export function keepLastApprovalWaitTraceEntry(entries: readonly TraceEntry[]): TraceEntry[] {
  let lastIdx = -1
  for (let i = 0; i < entries.length; i++) {
    if (isApprovalWaitEntry(entries[i]!)) lastIdx = i
  }
  if (lastIdx < 0) return [...entries]
  return entries.filter((entry, i) => !isApprovalWaitEntry(entry) || i === lastIdx)
}

/** Drop wait markers and ensure one approval-denied note. */
export function rewriteApprovalWaitEntriesToDenied(
  entries: readonly TraceEntry[],
  toolName: string,
  reason?: string | null,
): TraceEntry[] {
  const denied: TraceEntry = {
    kind: "approval-denied",
    toolName,
    ...(meaningfulDenyReason(reason) ? { reason: meaningfulDenyReason(reason) } : {}),
  }
  let wrote = false
  const out: TraceEntry[] = []
  for (const entry of entries) {
    if (isApprovalWaitEntry(entry) || isApprovalDeniedEntry(entry)) {
      if (!wrote) {
        out.push(denied)
        wrote = true
      }
      continue
    }
    out.push(entry)
  }
  if (!wrote) out.push(denied)
  return out
}

export function projectTraceForChatDisplay(
  entries: readonly TraceEntry[],
  runStatus: string,
): TraceEntry[] {
  if (runStatus === RunStatus.WaitingForApproval) {
    return keepLastApprovalWaitTraceEntry(entries)
  }
  return stripApprovalDeniedTraceEntries(stripApprovalWaitTraceEntries(entries))
}

export function approvalWaitFromEntry(
  entry: TraceEntry,
): { tool: string; reason: string } | null {
  if (!isApprovalWaitEntry(entry)) return null
  return { tool: entry.toolName, reason: entry.reason }
}

export function approvalDeniedFromEntry(
  entry: TraceEntry,
): { tool: string; reason: string } | null {
  if (!isApprovalDeniedEntry(entry)) return null
  return { tool: entry.toolName, reason: entry.reason ?? "" }
}
