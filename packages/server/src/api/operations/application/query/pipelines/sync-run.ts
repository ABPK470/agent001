/**
 * Unified sync-run pipeline: Preview + Execute phases under one audit tree.
 */

import { SyncRunStatus, syncExecuteCompletedHasWarnings } from "@mia/shared-enums"
import { OperationKind, OperationStatus } from "../../../../../internal/enums/operations.js"
import * as db from "../../../../../infra/persistence/sqlite.js"
import type { OperationActivity, OperationEvent, OperationPipeline } from "../types.js"
import { durationOf, inferPipelineStatus, strField } from "../utils.js"
import { buildSyncPipeline, summariseSyncEvents } from "./sync.js"

function isExecuteScopedSql(ev: OperationEvent): boolean {
  if (!ev.type.endsWith(".sql")) return false
  const scope = strField(ev.data, "scope")
  return (
    ev.type === "sync.execute.sql" ||
    scope === "execute" ||
    scope === "rollback" ||
    scope === "metadata" ||
    scope === "apply"
  )
}

function partitionSyncRunEvents(events: readonly OperationEvent[]): {
  preview: OperationEvent[]
  execute: OperationEvent[]
} {
  const preview: OperationEvent[] = []
  const execute: OperationEvent[] = []

  for (const ev of events) {
    if (ev.type.startsWith("sync.execute")) {
      execute.push(ev)
      continue
    }
    if (
      ev.type.startsWith("sync.preview") ||
      ev.type.startsWith("sync.catalog") ||
      ev.type.startsWith("sync.discovery")
    ) {
      preview.push(ev)
      continue
    }
    if (ev.type.endsWith(".sql")) {
      if (isExecuteScopedSql(ev)) execute.push(ev)
      else preview.push(ev)
    }
  }

  return { preview, execute }
}

function phaseActivity(
  id: "phase:preview" | "phase:execute",
  name: string,
  pipe: OperationPipeline,
  summaryKind: "preview" | "execute",
  events: OperationEvent[]
): OperationActivity {
  return {
    id,
    name,
    status: pipe.status,
    startedAt: pipe.startedAt,
    endedAt: pipe.endedAt,
    durationMs: pipe.durationMs,
    summary: summariseSyncEvents(summaryKind, events),
    error: pipe.status === OperationStatus.Failed ? pipe.error : undefined,
    events: [],
    children: pipe.activities
  }
}

export function buildSyncRunPipeline(planId: string, events: OperationEvent[]): OperationPipeline {
  const { preview, execute } = partitionSyncRunEvents(events)
  const previewPipe =
    preview.length > 0 ? buildSyncPipeline(planId, OperationKind.SyncPreview, preview) : null
  const executePipe =
    execute.length > 0 ? buildSyncPipeline(planId, OperationKind.SyncExecute, execute) : null

  const meta = db.getSyncRun?.(planId)
  const startedAt =
    previewPipe?.startedAt ?? executePipe?.startedAt ?? events[0]?.timestamp ?? new Date().toISOString()
  const endedAt = executePipe?.endedAt ?? previewPipe?.endedAt ?? null

  const executeCompletedWithWarnings = execute.some(
    (ev) => ev.type === "sync.execute.completed" && syncExecuteCompletedHasWarnings(ev.data)
  )

  let status: OperationStatus
  if (executePipe) {
    status =
      meta?.status === SyncRunStatus.Success && !executeCompletedWithWarnings
        ? OperationStatus.Success
        : meta?.status === SyncRunStatus.Failed || executeCompletedWithWarnings
          ? OperationStatus.Failed
          : meta?.status === SyncRunStatus.Skipped
            ? OperationStatus.Skipped
            : meta?.status === SyncRunStatus.Cancelled
              ? OperationStatus.Cancelled
              : executePipe.status
  } else if (previewPipe) {
    status = previewPipe.status
  } else {
    status = inferPipelineStatus(events)
  }

  const titleSource = executePipe ?? previewPipe
  const title = titleSource
    ? titleSource.title.replace(/^(Preview|Execute) /, "Sync ")
    : `Sync plan ${planId.slice(0, 8)}`

  const phases: OperationActivity[] = []
  if (previewPipe) phases.push(phaseActivity("phase:preview", "Preview", previewPipe, "preview", preview))
  if (executePipe) phases.push(phaseActivity("phase:execute", "Execute", executePipe, "execute", execute))

  return {
    id: planId,
    planId,
    kind: OperationKind.SyncRun,
    title,
    subtitle: titleSource?.subtitle ?? planId.slice(0, 8),
    status,
    startedAt,
    endedAt,
    durationMs: meta?.duration_ms ?? durationOf(startedAt, endedAt),
    activityCount: phases.length,
    eventCount: events.length,
    error: executePipe?.error ?? previewPipe?.error,
    activities: phases
  }
}
