/**
 * Build a Bridge preview or run pipeline from bridge.* events.
 *
 * Shape mirrors Sync Pipelines enough to be useful: route + spec labels in
 * title/subtitle, a config activity, and a transfer/preview activity that
 * folds mid-move progress into a live summary.
 */

import { EventType } from "@mia/shared-enums"
import { OperationKind, OperationStatus } from "../../../../../internal/enums/operations.js"
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
  const sourceSpec = strField(started?.data ?? {}, "sourceSpec")
  const targetSpec = strField(started?.data ?? {}, "targetSpec")
  const sourceKind = strField(started?.data ?? {}, "sourceKind")
  const targetKind = strField(started?.data ?? {}, "targetKind")
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

  const route =
    kind === OperationKind.BridgeRun && source && target
      ? `${source}${sourceKind ? ` (${sourceKind})` : ""} → ${target}${targetKind ? ` (${targetKind})` : ""}`
      : `${source}${sourceKind ? ` (${sourceKind})` : ""}`

  const subtitleParts = [
    route,
    sourceSpec && targetSpec
      ? `${sourceSpec} → ${targetSpec}`
      : sourceSpec ?? targetSpec,
    via === "agent" ? "via agent" : via === "ui" ? "via UI" : null,
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
  const started = events.find(
    (e) => e.type === EventType.BridgePreviewStarted || e.type === EventType.BridgeRunStarted,
  )
  const startedAt = started?.timestamp ?? events[0]!.timestamp
  const sourceSpec = strField(started?.data ?? {}, "sourceSpec")
  const targetSpec = strField(started?.data ?? {}, "targetSpec")
  const writeMode = strField(started?.data ?? {}, "writeMode")
  const allowIdentityInsert = started?.data["allowIdentityInsert"] === true
  const relaxConstraints = started?.data["relaxConstraints"] === true
  const hasTransform = started?.data["hasTransform"] === true

  const configDetails: Record<string, unknown> = {}
  if (sourceSpec) configDetails["sourceSpec"] = sourceSpec
  if (targetSpec) configDetails["targetSpec"] = targetSpec
  if (writeMode) configDetails["writeMode"] = writeMode
  if (allowIdentityInsert) configDetails["allowIdentityInsert"] = true
  if (relaxConstraints) configDetails["relaxConstraints"] = true
  if (hasTransform) configDetails["hasTransform"] = true

  const configSummary = [
    sourceSpec && targetSpec ? `${sourceSpec} → ${targetSpec}` : sourceSpec ?? targetSpec,
    writeMode ? `mode ${writeMode}` : null,
    allowIdentityInsert ? "identity" : null,
    relaxConstraints ? "relax" : null,
    hasTransform ? "transform" : null,
  ]
    .filter(Boolean)
    .join(" · ")

  const configActivity: OperationActivity = {
    id: "config",
    name: "Configured",
    status:
      pipelineStatus === OperationStatus.Running && events.length === 1
        ? OperationStatus.Running
        : OperationStatus.Success,
    startedAt,
    endedAt: started?.timestamp ?? startedAt,
    durationMs: 0,
    summary: configSummary || undefined,
    details: Object.keys(configDetails).length > 0 ? configDetails : undefined,
    events: started ? [started] : [],
  }

  if (kind === OperationKind.BridgePreview) {
    const terminal = events.find(
      (e) =>
        e.type === EventType.BridgePreviewCompleted || e.type === EventType.BridgePreviewFailed,
    )
    const workEvents = events.filter((e) => e.type !== EventType.BridgePreviewStarted)
    const rowCount = terminal ? numField(terminal.data, "rowCount") : null
    const durationMs =
      (terminal ? numField(terminal.data, "durationMs") : null) ??
      durationOf(startedAt, endedAt)
    const truncated = terminal?.data["truncated"] === true
    let summary: string | undefined
    if (rowCount != null) {
      summary = `${rowCount} row${rowCount === 1 ? "" : "s"} previewed${truncated ? " (truncated)" : ""}`
      if (durationMs != null) summary += ` · ${formatMs(durationMs)}`
    } else if (pipelineStatus === OperationStatus.Running) {
      summary = "reading…"
    }

    return [
      configActivity,
      {
        id: "preview",
        name: "Preview",
        status: pipelineStatus,
        startedAt,
        endedAt,
        durationMs: durationOf(startedAt, endedAt),
        summary,
        error:
          pipelineStatus === OperationStatus.Failed
            ? strField(terminal?.data ?? {}, "error") ?? undefined
            : undefined,
        events: workEvents,
      },
    ]
  }

  // Bridge run — transfer activity folds progress + terminal.
  const progressEvents = events.filter((e) => e.type === EventType.BridgeRunProgress)
  const terminal = events.find(
    (e) => e.type === EventType.BridgeRunCompleted || e.type === EventType.BridgeRunFailed,
  )
  const lastProgress = progressEvents[progressEvents.length - 1]
  const rowsRead =
    (terminal ? numField(terminal.data, "rowsRead") : null) ??
    (lastProgress ? numField(lastProgress.data, "rowsRead") : null)
  const rowsWritten =
    (terminal ? numField(terminal.data, "rowsWritten") : null) ??
    (lastProgress ? numField(lastProgress.data, "rowsWritten") : null)
  const durationMs =
    (terminal ? numField(terminal.data, "durationMs") : null) ??
    (lastProgress ? numField(lastProgress.data, "elapsedMs") : null) ??
    durationOf(startedAt, endedAt)
  const errorCount = terminal ? numField(terminal.data, "errorCount") : null
  const statusLabel = strField(terminal?.data ?? {}, "status")

  let summary: string | undefined
  if (rowsRead != null && rowsWritten != null) {
    summary = `read ${rowsRead} · wrote ${rowsWritten}`
    if (errorCount != null && errorCount > 0) summary += ` · ${errorCount} error(s)`
    if (statusLabel && statusLabel !== "ok" && statusLabel !== "completed") {
      summary += ` · ${statusLabel}`
    }
    if (durationMs != null) summary += ` · ${formatMs(durationMs)}`
  } else if (pipelineStatus === OperationStatus.Running) {
    summary = progressEvents.length > 0 ? "transferring…" : "starting…"
  }

  const transferDetails: Record<string, unknown> = {}
  if (rowsRead != null) transferDetails["rowsRead"] = rowsRead
  if (rowsWritten != null) transferDetails["rowsWritten"] = rowsWritten
  if (errorCount != null) transferDetails["errorCount"] = errorCount
  const errorsPreview = terminal?.data["errorsPreview"]
  if (Array.isArray(errorsPreview) && errorsPreview.length > 0) {
    transferDetails["errorsPreview"] = errorsPreview
  }

  const workEvents = events.filter((e) => e.type !== EventType.BridgeRunStarted)

  return [
    configActivity,
    {
      id: "transfer",
      name: "Transfer",
      status: pipelineStatus,
      startedAt,
      endedAt,
      durationMs: durationOf(startedAt, endedAt),
      summary,
      details: Object.keys(transferDetails).length > 0 ? transferDetails : undefined,
      error:
        pipelineStatus === OperationStatus.Failed
          ? strField(terminal?.data ?? {}, "error") ?? undefined
          : undefined,
      events: workEvents,
    },
  ]
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}
