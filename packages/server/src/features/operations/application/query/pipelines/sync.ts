/**
 * Build a sync preview or execute pipeline: entity name, route, decision log,
 * and per-table or per-step activities from sync.* events.
 */

import { EventType } from "@mia/agent"
import { SyncRunStatus } from "@mia/shared-enums"
import { readSseEntityId } from "@mia/shared-types"
import { OperationKind, OperationStatus } from "../../../../../shared/enums/operations.js"
import * as db from "../../../../../platform/persistence/sqlite.js"
import { loadPersistedSyncPlanSummary } from "../../../../sync/application/plan-summary.js"
import type { OperationActivity, OperationEvent, OperationPipeline } from "../types.js"
import {
  durationOf,
  humanizeEntityType,
  inferPipelineStatus,
  numField,
  readTableCounts,
  strField
} from "../utils.js"

export function buildSyncPipeline(
  planId: string,
  kind: typeof OperationKind.SyncPreview | typeof OperationKind.SyncExecute,
  events: OperationEvent[]
): OperationPipeline {
  const meta = db.getSyncRun?.(planId)
  const planSummary = loadPersistedSyncPlanSummary(planId)
  const eventHints = extractSyncEntityHintsFromEvents(events)
  const startedAt = events[0].timestamp
  const lastEv = events[events.length - 1]
  const inferred = inferPipelineStatus(events)
  const status: OperationStatus =
    kind === OperationKind.SyncExecute
      ? meta?.status === SyncRunStatus.Success
        ? OperationStatus.Success
        : meta?.status === SyncRunStatus.Failed
          ? OperationStatus.Failed
          : meta?.status === SyncRunStatus.Skipped
            ? OperationStatus.Skipped
            : inferred
      : inferred
  const endedAt =
    kind === OperationKind.SyncExecute
      ? meta?.finished_at ?? (status !== OperationStatus.Running ? lastEv.timestamp : null)
      : status !== OperationStatus.Running
        ? lastEv.timestamp
        : null
  const entityType = planSummary?.entityType ?? meta?.entity_type ?? eventHints.entityType ?? null
  const entityTypeLabel = humanizeEntityType(
    planSummary?.definitionId ?? eventHints.definitionId ?? entityType
  )
  const entityRef = `${entityType ?? eventHints.entityType ?? "?"}#${meta?.entity_id ?? eventHints.entityId ?? "?"}`
  const entityName =
    planSummary?.entityName ??
    meta?.entity_display_name ??
    eventHints.entityDisplayName ??
    entityRef
  const route =
    planSummary?.source && planSummary?.target
      ? `${planSummary.source} → ${planSummary.target}`
      : meta
        ? `${meta.source} → ${meta.target}`
        : eventHints.source && eventHints.target
          ? `${eventHints.source} → ${eventHints.target}`
          : ""
  const subtitleParts = [route]
  if (planSummary?.definitionPublishedVersion)
    subtitleParts.push(`def ${planSummary.definitionPublishedVersion}`)

  const activities =
    kind === OperationKind.SyncPreview
      ? [...buildDecisionActivities(planSummary, startedAt), ...groupSyncPreviewActivities(events)]
      : [...buildDecisionActivities(planSummary, startedAt), ...groupSyncExecuteActivities(events)]

  return {
    id: `${planId}:${kind === OperationKind.SyncExecute ? "execute" : "preview"}`,
    planId,
    kind,
    title: `${kind === OperationKind.SyncExecute ? "Execute" : "Preview"} ${entityTypeLabel} — ${entityName}`,
    subtitle: subtitleParts.filter(Boolean).join(" · ") || planId.slice(0, 8),
    status,
    startedAt,
    endedAt,
    durationMs:
      kind === OperationKind.SyncExecute
        ? meta?.duration_ms ?? durationOf(startedAt, endedAt)
        : durationOf(startedAt, endedAt),
    activityCount: activities.length,
    eventCount: events.length,
    error: kind === OperationKind.SyncExecute ? meta?.error ?? undefined : undefined,
    activities
  }
}

export function summariseSyncEvents(
  kind: "preview" | "execute",
  events: OperationEvent[]
): string | undefined {
  for (const ev of events) {
    if (kind === "preview" && ev.type === EventType.SyncPreviewCompleted) {
      const totals = ev.data["totals"] as Record<string, unknown> | undefined
      if (totals)
        return `${totals["insert"] ?? 0} ins · ${totals["update"] ?? 0} upd · ${totals["delete"] ?? 0} del`
    }
    if (kind === "execute" && ev.type === EventType.SyncExecuteCompleted) {
      const applied = ev.data["applied"] as Record<string, unknown> | undefined
      if (applied)
        return `${applied["insert"] ?? 0} ins · ${applied["update"] ?? 0} upd · ${applied["delete"] ?? 0} del`
    }
  }
  return undefined
}

function extractSyncEntityHintsFromEvents(events: OperationEvent[]): {
  entityType: string | null
  entityId: string | null
  entityDisplayName: string | null
  source: string | null
  target: string | null
  definitionId: string | null
} {
  let entityType: string | null = null
  let entityId: string | null = null
  let entityDisplayName: string | null = null
  let source: string | null = null
  let target: string | null = null
  let definitionId: string | null = null

  for (const ev of events) {
    if (!ev.type.startsWith("sync.preview") && !ev.type.startsWith("sync.execute")) continue
    entityType ??= strField(ev.data, "entityType")
    definitionId ??= strField(ev.data, "definitionId")
    const rawId = readSseEntityId(ev.data)
    if (entityId == null && rawId != null) {
      entityId = rawId
    }
    entityDisplayName ??= strField(ev.data, "entityDisplayName") ?? strField(ev.data, "entityName")
    source ??= strField(ev.data, "source")
    target ??= strField(ev.data, "target")
  }

  return { entityType, entityId, entityDisplayName, source, target, definitionId }
}

function buildDecisionActivities(
  planSummary: ReturnType<typeof loadPersistedSyncPlanSummary>,
  fallbackTimestamp: string
): OperationActivity[] {
  if (!planSummary || planSummary.decisionLog.length === 0) return []
  return planSummary.decisionLog.map((decision, index) => ({
    id: `decision:${decision.id}:${index}`,
    name: decision.title,
    status: decision.severity === "error" ? OperationStatus.Failed : OperationStatus.Success,
    startedAt: decision.recordedAt ?? fallbackTimestamp,
    endedAt: decision.recordedAt ?? fallbackTimestamp,
    durationMs: 0,
    summary: decision.summary,
    ...(decision.details ? { details: decision.details } : {}),
    events: []
  }))
}

function groupSyncPreviewActivities(events: OperationEvent[]): OperationActivity[] {
  const activities: OperationActivity[] = []
  const miscEvents: OperationEvent[] = []
  const openTables = new Map<string, OperationActivity>()

  for (const ev of events) {
    const t = ev.type
    const table = strField(ev.data, "table")

    if (t === EventType.SyncPreviewStarted) {
      const source = strField(ev.data, "source")
      const target = strField(ev.data, "target")
      activities.push({
        id: "preview-started",
        name: "Preview started",
        status: OperationStatus.Success,
        startedAt: ev.timestamp,
        endedAt: ev.timestamp,
        durationMs: 0,
        summary: source && target ? `${source} → ${target}` : undefined,
        events: [ev]
      })
      continue
    }
    if (t === EventType.SyncPreviewCompleted) {
      const totals = ev.data["totals"] as Record<string, unknown> | undefined
      const summary = totals
        ? `${totals["insert"] ?? 0} ins · ${totals["update"] ?? 0} upd · ${totals["delete"] ?? 0} del`
        : undefined
      activities.push({
        id: "preview-completed",
        name: "Preview completed",
        status: OperationStatus.Success,
        startedAt: ev.timestamp,
        endedAt: ev.timestamp,
        durationMs: numField(ev.data, "durationMs"),
        summary,
        events: [ev]
      })
      continue
    }
    if (t === EventType.SyncPreviewFailed) {
      activities.push({
        id: "preview-failed",
        name: "Preview failed",
        status: OperationStatus.Failed,
        startedAt: ev.timestamp,
        endedAt: ev.timestamp,
        durationMs: numField(ev.data, "durationMs"),
        error: strField(ev.data, "error") ?? undefined,
        events: [ev]
      })
      continue
    }

    if (t === EventType.SyncPreviewTableStart && table) {
      const act: OperationActivity = {
        id: `tbl:${table}:${activities.length}`,
        name: table,
        status: OperationStatus.Running,
        startedAt: ev.timestamp,
        endedAt: null,
        durationMs: null,
        events: [ev]
      }
      activities.push(act)
      openTables.set(table, act)
      continue
    }
    if ((t === EventType.SyncPreviewTableDone || t === EventType.SyncPreviewTableFailed) && table) {
      const open = openTables.get(table)
      if (open) {
        open.events.push(ev)
        open.endedAt = ev.timestamp
        open.durationMs = durationOf(open.startedAt, ev.timestamp)
        open.status = t === EventType.SyncPreviewTableDone ? OperationStatus.Success : OperationStatus.Failed
        if (t === EventType.SyncPreviewTableFailed) open.error = strField(ev.data, "error") ?? "scan failed"
        const counts = readTableCounts(ev.data)
        if (counts) open.summary = `${counts.insert} ins · ${counts.update} upd · ${counts.delete} del`
        const scanMs = numField(ev.data, "durationMs")
        if (scanMs != null && open.summary) open.summary += ` · ${scanMs}ms`
        else if (scanMs != null) open.summary = `${scanMs}ms`
        openTables.delete(table)
      } else {
        miscEvents.push(ev)
      }
      continue
    }
    if (table && openTables.has(table)) {
      openTables.get(table)!.events.push(ev)
      continue
    }
    miscEvents.push(ev)
  }

  if (miscEvents.length > 0) {
    const start = miscEvents[0].timestamp
    const end = miscEvents[miscEvents.length - 1].timestamp
    activities.push({
      id: "preview-other",
      name: "Other preview events",
      status: inferPipelineStatus(miscEvents),
      startedAt: start,
      endedAt: end,
      durationMs: durationOf(start, end),
      events: miscEvents
    })
  }

  activities.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return activities
}

function groupSyncExecuteActivities(events: OperationEvent[]): OperationActivity[] {
  const activities: OperationActivity[] = []
  let currentStep: OperationActivity | null = null
  let currentTable: { name: string; act: OperationActivity } | null = null

  const closeStep = (endTs: string): void => {
    if (currentStep) {
      currentStep.endedAt = endTs
      currentStep.durationMs = durationOf(currentStep.startedAt, endTs)
      if (currentStep.status === OperationStatus.Running) currentStep.status = OperationStatus.Success
      currentStep = null
    }
  }

  const closeTable = (endTs: string): void => {
    if (currentTable) {
      currentTable.act.endedAt = endTs
      currentTable.act.durationMs = durationOf(currentTable.act.startedAt, endTs)
      if (currentTable.act.status === OperationStatus.Running)
        currentTable.act.status = OperationStatus.Success
      currentTable = null
    }
  }

  const pushLifecycleActivity = (ev: OperationEvent): void => {
    const type = ev.type
    let name = type.replace(/^sync\.execute\./, "")
    let status: OperationStatus = OperationStatus.Success
    let summary: string | undefined
    let error: string | undefined

    if (type === EventType.SyncExecuteStarted) {
      const source = strField(ev.data, "source")
      const target = strField(ev.data, "target")
      summary = source && target ? `${source} → ${target}` : undefined
    } else if (type === EventType.SyncExecuteCompleted) {
      const applied = ev.data["applied"] as Record<string, unknown> | undefined
      if (applied) {
        summary = `${applied["insert"] ?? 0} ins · ${applied["update"] ?? 0} upd · ${applied["delete"] ?? 0} del`
      }
    } else if (type === EventType.SyncExecuteFailed) {
      status = OperationStatus.Failed
      error = strField(ev.data, "error") ?? undefined
      summary = error
    } else if (type === EventType.SyncExecuteSkipped) {
      status = OperationStatus.Skipped
      name = "Execute skipped"
      summary = strField(ev.data, "message") ?? strField(ev.data, "step") ?? undefined
    } else if (type === EventType.SyncExecuteArchiveSkipped) {
      summary = strField(ev.data, "reason") ?? undefined
    } else if (type === EventType.SyncExecuteArchiveProbeBatch) {
      const tables = Array.isArray(ev.data["tables"]) ? (ev.data["tables"] as unknown[]).length : null
      const durationMs = numField(ev.data, "durationMs")
      summary =
        [tables != null ? `${tables} tables` : null, durationMs != null ? `${durationMs}ms` : null]
          .filter(Boolean)
          .join(" · ") || undefined
    }

    activities.push({
      id: `elifecycle:${activities.length}`,
      name,
      status,
      startedAt: ev.timestamp,
      endedAt: ev.timestamp,
      durationMs: 0,
      ...(summary ? { summary } : {}),
      ...(error ? { error } : {}),
      events: [ev]
    })
  }

  for (const ev of events) {
    const t = ev.type
    if (
      t === EventType.SyncExecuteStarted ||
      t === EventType.SyncExecuteCompleted ||
      t === EventType.SyncExecuteFailed ||
      t === EventType.SyncExecuteSkipped ||
      t === EventType.SyncExecuteArchiveSkipped ||
      t === EventType.SyncExecuteArchiveProbeBatch
    ) {
      closeTable(ev.timestamp)
      closeStep(ev.timestamp)
      pushLifecycleActivity(ev)
      continue
    }
    if (t === EventType.SyncExecuteStep) {
      closeStep(ev.timestamp)
      const stepName = strField(ev.data, "step") ?? "step"
      currentStep = {
        id: `estep:${activities.length}`,
        name: stepName,
        status: OperationStatus.Running,
        startedAt: ev.timestamp,
        endedAt: null,
        durationMs: null,
        events: [ev]
      }
      activities.push(currentStep)
      continue
    }
    if (t === EventType.SyncExecuteStepFailed) {
      const stepName = strField(ev.data, "step") ?? "step"
      const errMsg = strField(ev.data, "error") ?? OperationStatus.Failed
      if (currentStep && currentStep.name === stepName) {
        currentStep.events.push(ev)
        currentStep.status = OperationStatus.Failed
        currentStep.error = errMsg
        currentStep.endedAt = ev.timestamp
        currentStep.durationMs = durationOf(currentStep.startedAt, ev.timestamp)
        currentStep = null
      } else {
        activities.push({
          id: `estep:${activities.length}`,
          name: stepName,
          status: OperationStatus.Failed,
          startedAt: ev.timestamp,
          endedAt: ev.timestamp,
          durationMs: 0,
          error: errMsg,
          events: [ev]
        })
      }
      continue
    }
    if (t === EventType.SyncExecuteTableStart) {
      closeStep(ev.timestamp)
      const tableName = strField(ev.data, "table") ?? "table"
      const op = strField(ev.data, "op") ?? "apply"
      const rows = numField(ev.data, "rowsTotal")
      const act: OperationActivity = {
        id: `etbl:${activities.length}`,
        name: `${tableName} (${op}${rows != null ? ` ${rows} rows` : ""})`,
        status: OperationStatus.Running,
        startedAt: ev.timestamp,
        endedAt: null,
        durationMs: null,
        events: [ev]
      }
      activities.push(act)
      currentTable = { name: tableName, act }
      continue
    }
    if (t === EventType.SyncExecuteTableDone && currentTable) {
      currentTable.act.events.push(ev)
      currentTable.act.endedAt = ev.timestamp
      currentTable.act.durationMs = durationOf(currentTable.act.startedAt, ev.timestamp)
      currentTable.act.status = OperationStatus.Success
      const applied = numField(ev.data, "rowsApplied")
      if (applied != null) currentTable.act.summary = `${applied} rows applied`
      currentTable = null
      continue
    }
    if (t === EventType.SyncExecuteTableDone) {
      pushLifecycleActivity(ev)
      continue
    }

    if (currentTable) {
      currentTable.act.events.push(ev)
      continue
    }
    if (currentStep) {
      currentStep.events.push(ev)
      continue
    }

    pushLifecycleActivity(ev)
  }

  if (currentStep) {
    closeStep(events[events.length - 1].timestamp)
  }

  return activities
}
