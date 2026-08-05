import type { ApprovalTraceIdentity, TraceEntry } from "@mia/shared-types"
import { RunStatus } from "../enums"
import { normalizeApprovalDeniedReason } from "./approval-copy"

type ApprovalWaitEntry = Extract<TraceEntry, { kind: "approval-wait" }>
type ApprovalDeniedEntry = Extract<TraceEntry, { kind: "approval-denied" }>

export interface ApprovalDenial extends ApprovalTraceIdentity {
  reason?: string | null
}

export function isApprovalWaitEntry(entry: TraceEntry): entry is ApprovalWaitEntry {
  return entry.kind === "approval-wait"
}

export function isApprovalDeniedEntry(entry: TraceEntry): entry is ApprovalDeniedEntry {
  return entry.kind === "approval-denied"
}

export function appendApprovalDeniedTraceEntry(
  entries: TraceEntry[],
  denial: ApprovalDenial,
): TraceEntry[] {
  let hasWait = false
  for (const entry of entries) {
    if (!isApprovalWaitEntry(entry) && !isApprovalDeniedEntry(entry)) continue
    if (entry.approvalId !== denial.approvalId) continue
    if (isApprovalDeniedEntry(entry)) return entries
    hasWait = true
  }
  if (!hasWait) return entries

  const normalizedReason = normalizeApprovalDeniedReason(denial.reason)
  const denied: ApprovalDeniedEntry = {
    kind: "approval-denied",
    approvalId: denial.approvalId,
    stepId: denial.stepId,
    toolName: denial.toolName,
    ...(normalizedReason ? { reason: normalizedReason } : {}),
  }
  return [...entries, denied]
}

export function stripApprovalWaitTraceEntries(
  entries: readonly TraceEntry[],
): TraceEntry[] {
  return entries.filter((entry) => !isApprovalWaitEntry(entry))
}

export function projectTraceForChatDisplay(
  entries: readonly TraceEntry[],
  runStatus: string,
): TraceEntry[] {
  if (runStatus !== RunStatus.WaitingForApproval) {
    return entries.filter(
      (entry) =>
        !isApprovalWaitEntry(entry) &&
        !isApprovalDeniedEntry(entry),
    )
  }

  const deniedApprovals = new Set(
    entries
      .filter(isApprovalDeniedEntry)
      .map((entry) => entry.approvalId),
  )
  let activeWaitIndex = -1
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (
      isApprovalWaitEntry(entry) &&
      !deniedApprovals.has(entry.approvalId)
    ) {
      activeWaitIndex = index
    }
  }

  return entries.filter((entry, index) => {
    if (isApprovalDeniedEntry(entry)) return false
    if (isApprovalWaitEntry(entry)) return index === activeWaitIndex
    return true
  })
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
