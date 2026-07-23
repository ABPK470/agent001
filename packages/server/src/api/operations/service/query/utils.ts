import { parseBoundaryJson } from "../../../../internal/parse-json.js"

/**
 * Small helpers shared across pipeline builders: parse JSON, read fields,
 * compute duration, infer success/failed/running from event sequences.
 */

import {
  isCancellationEvent,
  isCompletionEvent,
  isFailureEvent,
  isSkippedEvent,
  isSubStepFailureEvent,
  syncExecuteCompletedHasWarnings,
} from "@mia/agent"
import { SyncRunStatus } from "@mia/shared-enums"
import { OperationStatus } from "./types.js"
import type { OperationActivity, OperationEvent } from "./types.js"

export function safeParse(s: string): Record<string, unknown> {
  try {
    return parseBoundaryJson(s) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function strField(d: Record<string, unknown>, k: string): string | null {
  const v = d[k]
  return typeof v === "string" && v.length > 0 ? v : null
}

export function numField(d: Record<string, unknown>, k: string): number | null {
  const v = d[k]
  return typeof v === "number" ? v : null
}

export function durationOf(start: string, end: string | null): number | null {
  if (!end) return null
  const a = Date.parse(start)
  const b = Date.parse(end)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null
}

export function humanizeEntityType(value: string | null | undefined): string {
  if (!value) return "Entity"
  switch (value) {
    case "pipelineActivity":
      return "Pipeline Activity"
    case "gateMetadata":
      return "Gate Metadata"
    default:
      return value
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase())
  }
}

export function inferPipelineStatus(events: OperationEvent[]): OperationStatus {
  const hasSubStepFailure =
    events.some((e) => isSubStepFailureEvent(e.type))
    || events.some((e) => e.type === "sync.execute.completed" && syncExecuteCompletedHasWarnings(e.data))
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    const t = ev.type
    if (isSkippedEvent(t)) return OperationStatus.Skipped
    if (isCompletionEvent(t)) {
      if (t === "sync.execute.completed" && syncExecuteCompletedHasWarnings(ev.data)) {
        return OperationStatus.Failed
      }
      return hasSubStepFailure ? OperationStatus.Failed : OperationStatus.Success
    }
    if (isFailureEvent(t)) return OperationStatus.Failed
    if (isCancellationEvent(t)) return OperationStatus.Cancelled
  }
  return hasSubStepFailure ? OperationStatus.Failed : OperationStatus.Running
}

export function readTableCounts(data: Record<string, unknown>): {
  insert: number
  update: number
  delete: number
} | null {
  const counts = data["counts"]
  const source =
    counts && typeof counts === "object" && !Array.isArray(counts)
      ? (counts as Record<string, unknown>)
      : data
  const insert = numField(source, "insert")
  const update = numField(source, "update")
  const del = numField(source, "delete")
  if (insert == null && update == null && del == null) return null
  return { insert: insert ?? 0, update: update ?? 0, delete: del ?? 0 }
}

export function resolveSyncPlanId(
  ev: OperationEvent,
  previewToPlan: Map<string, string>
): string | null {
  const planId = strField(ev.data, "planId")
  if (planId) return planId
  const opId = strField(ev.data, "opId")
  if (opId && ev.type.startsWith("sync.execute")) return opId
  const previewId = strField(ev.data, "previewId")
  if (previewId) return previewToPlan.get(previewId) ?? null
  if (opId && ev.type.startsWith("sync.preview")) return previewToPlan.get(opId) ?? null
  return null
}

export function syncRunStatusToOperationStatus(
  metaStatus: string | null | undefined,
  inferred: OperationStatus,
  opts?: { executeCompletedWithWarnings?: boolean }
): OperationStatus {
  if (metaStatus === SyncRunStatus.Success) {
    return opts?.executeCompletedWithWarnings ? OperationStatus.Failed : OperationStatus.Success
  }
  if (metaStatus === SyncRunStatus.Failed) return OperationStatus.Failed
  if (metaStatus === SyncRunStatus.Skipped) return OperationStatus.Skipped
  if (metaStatus === SyncRunStatus.Cancelled) return OperationStatus.Cancelled
  if (metaStatus === SyncRunStatus.Started || metaStatus === SyncRunStatus.Preview) {
    return inferred === OperationStatus.Unknown ? OperationStatus.Running : inferred
  }
  return inferred
}

/** Close activities still marked running when sync_runs says the run ended. */
export function finalizeStaleRunningActivities(
  activities: OperationActivity[],
  endTs: string,
  terminal: OperationStatus,
  reason?: string
): void {
  if (terminal === OperationStatus.Running || terminal === OperationStatus.Unknown) return
  const walk = (rows: OperationActivity[]): void => {
    for (const row of rows) {
      if (row.status === OperationStatus.Running) {
        row.status = terminal
        row.endedAt = endTs
        row.durationMs = durationOf(row.startedAt, endTs)
        if (reason && !row.summary) row.summary = reason
        if (reason && terminal === OperationStatus.Failed) row.error = reason
      }
      if (row.children?.length) walk(row.children)
    }
  }
  walk(activities)
}
