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
import { OperationStatus } from "./types.js"
import type { OperationEvent } from "./types.js"

export function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>
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
  const previewId = strField(ev.data, "previewId")
  if (previewId) return previewToPlan.get(previewId) ?? null
  return null
}
