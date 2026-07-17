/**
 * Build a Bridge preview or run pipeline from bridge.* events.
 */

import { EventType } from "@mia/shared-enums"
import { OperationKind, OperationStatus } from "../../../../../shared/enums/operations.js"
import type { OperationActivity, OperationEvent, OperationPipeline } from "../types.js"
import { durationOf, inferPipelineStatus, numField, strField } from "../utils.js"

export function buildBridgePipeline(
  moveId: string,
  kind: typeof OperationKind.BridgePreview | typeof OperationKind.BridgeRun,
  events: OperationEvent[],
): OperationPipeline {
  const startedAt = events[0]!.timestamp
  const lastEv = events[events.length - 1]!
  let status = inferPipelineStatus(events)

  // Partial move wrote some rows but reported errors — surface as failed.
  const completed = events.find(
    (e) => e.type === EventType.BridgeRunCompleted || e.type === EventType.BridgePreviewCompleted,
  )
  if (completed && strField(completed.data, "status") === "partial") {
    status = OperationStatus.Failed
  }

  const endedAt = status !== OperationStatus.Running ? lastEv.timestamp : null
  const started = events.find(
    (e) => e.type === EventType.BridgePreviewStarted || e.type === EventType.BridgeRunStarted,
  )
  const source = strField(started?.data ?? {}, "source") ?? strField(lastEv.data, "source") ?? "?"
  const target =
    kind === OperationKind.BridgeRun
      ? (strField(started?.data ?? {}, "target") ?? strField(lastEv.data, "target") ?? "?")
      : null
  const via = strField(started?.data ?? {}, "via")
  const failed = events.find(
    (e) => e.type === EventType.BridgePreviewFailed || e.type === EventType.BridgeRunFailed,
  )
  const error =
    strField(failed?.data ?? {}, "error") ??
    (strField(completed?.data ?? {}, "status") === "partial"
      ? `partial — ${numField(completed!.data, "errorCount") ?? "?"} error(s)`
      : undefined)

  const activities = buildBridgeActivities(kind, events, status, endedAt)

  const title =
    kind === OperationKind.BridgePreview
      ? `Bridge preview — ${source}`
      : `Bridge move — ${source} → ${target}`

  const subtitleParts = [
    kind === OperationKind.BridgeRun && source && target ? `${source} → ${target}` : source,
    via === "agent" ? "via agent" : null,
    moveId.slice(0, 8),
  ].filter(Boolean)

  return {
    id: `${moveId}:${kind === OperationKind.BridgeRun ? "run" : "preview"}`,
    kind,
    title,
    subtitle: subtitleParts.join(" · "),
    status,
    startedAt,
    endedAt,
    durationMs: durationOf(startedAt, endedAt),
    activityCount: activities.length,
    eventCount: events.length,
    error,
    activities,
  }
}

function buildBridgeActivities(
  kind: typeof OperationKind.BridgePreview | typeof OperationKind.BridgeRun,
  events: OperationEvent[],
  pipelineStatus: OperationStatus,
  endedAt: string | null,
): OperationActivity[] {
  const startedAt = events[0]!.timestamp
  const completed = events.find(
    (e) =>
      e.type === EventType.BridgePreviewCompleted ||
      e.type === EventType.BridgeRunCompleted ||
      e.type === EventType.BridgePreviewFailed ||
      e.type === EventType.BridgeRunFailed,
  )
  const rowCount = completed ? numField(completed.data, "rowCount") : null
  const rowsRead = completed ? numField(completed.data, "rowsRead") : null
  const rowsWritten = completed ? numField(completed.data, "rowsWritten") : null

  let summary: string | undefined
  if (kind === OperationKind.BridgePreview && rowCount != null) {
    summary = `${rowCount} row${rowCount === 1 ? "" : "s"} previewed`
  } else if (kind === OperationKind.BridgeRun && rowsRead != null && rowsWritten != null) {
    summary = `read ${rowsRead} · wrote ${rowsWritten}`
  }

  return [
    {
      id: kind === OperationKind.BridgeRun ? "move" : "preview",
      name: kind === OperationKind.BridgeRun ? "Move" : "Preview",
      status: pipelineStatus,
      startedAt,
      endedAt,
      durationMs: durationOf(startedAt, endedAt),
      summary,
      error:
        pipelineStatus === OperationStatus.Failed
          ? strField(completed?.data ?? {}, "error") ?? undefined
          : undefined,
      events,
    },
  ]
}
