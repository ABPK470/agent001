/**
 * Build a sync preview or execute pipeline: entity name, route, decision log,
 * and per-table or per-step activities from sync.* events.
 */

import { EventType } from "@mia/agent"
import { syncExecuteCompletedHasWarnings } from "@mia/shared-enums"
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
  strField,
  syncRunStatusToOperationStatus,
  finalizeStaleRunningActivities
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
  const executeCompletedWithWarnings = events.some(
    (ev) => ev.type === EventType.SyncExecuteCompleted && syncExecuteCompletedHasWarnings(ev.data),
  )
  const status =
    kind === OperationKind.SyncPreview && inferred !== OperationStatus.Running
      ? inferred
      : syncRunStatusToOperationStatus(meta?.status, inferred, {
          executeCompletedWithWarnings
        })
  const endedAt =
    meta?.finished_at ??
    (status !== OperationStatus.Running ? lastEv.timestamp : null)

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
  const runId = extractRunIdFromEvents(events)
  const subtitleParts = [route]
  if (planSummary?.definitionPublishedVersion)
    subtitleParts.push(`def ${planSummary.definitionPublishedVersion}`)
  if (runId) subtitleParts.push(`via agent ${runId.slice(0, 8)}`)

  const activities =
    kind === OperationKind.SyncPreview
      ? [...buildPreflightActivity(planSummary, startedAt), ...groupSyncPreviewActivities(events)]
      : [...buildPreflightActivity(planSummary, startedAt), ...groupSyncExecuteActivities(events)]

  if (status !== OperationStatus.Running && endedAt) {
    finalizeStaleRunningActivities(
      activities,
      endedAt,
      status,
      meta?.error ?? (status === OperationStatus.Skipped ? "Skipped" : undefined)
    )
  }

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

function extractRunIdFromEvents(events: OperationEvent[]): string | null {
  for (const ev of events) {
    const runId = strField(ev.data, "runId")
    if (runId) return runId
  }
  return null
}

function buildPreflightActivity(
  planSummary: ReturnType<typeof loadPersistedSyncPlanSummary>,
  fallbackTimestamp: string
): OperationActivity[] {
  if (!planSummary || planSummary.decisionLog.length === 0) return []
  const decisions = planSummary.decisionLog
  const startedAt = decisions[0]?.recordedAt ?? fallbackTimestamp
  const endedAt = decisions[decisions.length - 1]?.recordedAt ?? fallbackTimestamp
  const hasError = decisions.some((decision) => decision.severity === "error")
  return [
    {
      id: "preflight",
      name: "Preflight checks",
      status: hasError ? OperationStatus.Failed : OperationStatus.Success,
      startedAt,
      endedAt,
      durationMs: durationOf(startedAt, endedAt),
      summary: `${decisions.length} check(s) from preview`,
      details: {
        decisions: decisions.map((decision) => ({
          id: decision.id,
          title: decision.title,
          summary: decision.summary,
          severity: decision.severity,
          ...(decision.details ? { details: decision.details } : {})
        }))
      },
      events: []
    }
  ]
}

function groupSyncPreviewActivities(events: OperationEvent[]): OperationActivity[] {
  const activities: OperationActivity[] = []
  const openTables = new Map<string, OperationActivity>()
  const pipelineFailed = events.some((ev) => ev.type === EventType.SyncPreviewFailed)

  const failOpenTables = (endTs: string, reason?: string): void => {
    for (const child of openTables.values()) {
      child.status = OperationStatus.Failed
      child.endedAt = endTs
      child.durationMs = durationOf(child.startedAt, endTs)
      child.error = reason ?? "Preview failed"
      child.summary = reason ?? "Preview failed"
    }
    openTables.clear()
  }

  for (const ev of events) {
    const t = ev.type
    const table = strField(ev.data, "table")

    if (t === EventType.SyncPreviewStarted) {
      const source = strField(ev.data, "source")
      const target = strField(ev.data, "target")
      activities.push({
        id: "preview-started",
        name: "started",
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
        name: "completed",
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
      const error = strField(ev.data, "error") ?? undefined
      failOpenTables(ev.timestamp, error ?? "Preview failed")
      activities.push({
        id: "preview-failed",
        name: "failed",
        status: OperationStatus.Failed,
        startedAt: ev.timestamp,
        endedAt: ev.timestamp,
        durationMs: numField(ev.data, "durationMs"),
        error,
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
        activities.push({
          id: `tbl-orphan:${table}:${activities.length}`,
          name: table,
          status: t === EventType.SyncPreviewTableDone ? OperationStatus.Success : OperationStatus.Failed,
          startedAt: ev.timestamp,
          endedAt: ev.timestamp,
          durationMs: numField(ev.data, "durationMs"),
          events: [ev]
        })
      }
      continue
    }
    if (table && openTables.has(table)) {
      openTables.get(table)!.events.push(ev)
      continue
    }

    if (t.endsWith(".sql")) {
      const sqlLabel = strField(ev.data, "label") ?? "query"
      let attached = false
      for (const [tbl, act] of openTables) {
        if (sqlLabel.includes(tbl)) {
          act.events.push(ev)
          attached = true
          break
        }
      }
      if (!attached) {
        activities.push({
          id: `sql:${activities.length}`,
          name: `SQL · ${sqlLabel}`,
          status: ev.data["error"] ? OperationStatus.Failed : OperationStatus.Success,
          startedAt: ev.timestamp,
          endedAt: ev.timestamp,
          durationMs: numField(ev.data, "durationMs"),
          summary: [
            strField(ev.data, "connection"),
            numField(ev.data, "rowCount") != null ? `${numField(ev.data, "rowCount")} rows` : null,
          ].filter(Boolean).join(" · ") || undefined,
          events: [ev],
        })
      }
      continue
    }

    activities.push({
      id: `preview-misc:${activities.length}`,
      name: formatEventTypeName(t),
      status: OperationStatus.Success,
      startedAt: ev.timestamp,
      endedAt: ev.timestamp,
      durationMs: 0,
      events: [ev]
    })
  }

  const lastTs = events[events.length - 1]?.timestamp ?? new Date().toISOString()
  if (pipelineFailed && openTables.size > 0) {
    failOpenTables(lastTs)
  }

  return activities
}

function formatEventTypeName(type: string): string {
  return type.replace(/^sync\.(preview|execute)\./, "").replace(/\./g, " ")
}

const SYNC_EXECUTE_STEP_LABELS: Record<string, string> = {
  auditCheck: "Verify source audit gate before applying changes",
  targetLock: "Acquire exclusive lock on target entity",
  metadataSync: "Deploy metadata tables (FK-ordered upserts)",
  "metadataSync-done": "Metadata deploy finished",
  deployEtl: "Trigger ETL deployment on target",
  "deploy-etl": "Trigger ETL deployment on target",
  pipelineStart: "Start registered pipeline on target service",
  setSyncDate: "Stamp target row sync date",
  setDeployDate: "Stamp target row deploy date",
  syncDate: "Stamp target row sync date",
  deployDate: "Stamp target row deploy date",
  contractDeploy: "Run full contract deployment sequence",
  datasetDeploy: "Trigger dataset deployment in ETL",
  rulesDeploy: "Trigger rule deployment in ETL",
}

function syncExecuteStepSummary(stepName: string): string | undefined {
  return (
    SYNC_EXECUTE_STEP_LABELS[stepName] ??
    SYNC_EXECUTE_STEP_LABELS[stepName.replace(/-done$/, "Done")] ??
    undefined
  )
}

function findFlowStepActivity(activities: OperationActivity[], stepName: string): OperationActivity | null {
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i]!
    if (activity.name === stepName && !activity.id.startsWith("lifecycle:")) {
      return activity
    }
  }
  return null
}

function attachSkipResultToStep(
  step: OperationActivity,
  ev: OperationEvent,
  message: string
): void {
  step.status = OperationStatus.Skipped
  step.endedAt = ev.timestamp
  step.durationMs = durationOf(step.startedAt, ev.timestamp)
  step.children = step.children ?? []
  step.children.push({
    id: `result:${step.id}:${step.children.length}`,
    name: "result",
    status: OperationStatus.Skipped,
    startedAt: ev.timestamp,
    endedAt: ev.timestamp,
    durationMs: numField(ev.data, "durationMs") ?? durationOf(step.startedAt, ev.timestamp),
    summary: message,
    events: [ev]
  })
}

function applyExecuteSkipped(
  ev: OperationEvent,
  activities: OperationActivity[],
  currentStep: OperationActivity | null,
  finalizeStep: (endTs: string, status?: OperationStatus, error?: string) => void
): void {
  const stepName = strField(ev.data, "step")
  const message = strField(ev.data, "message") ?? "Execute skipped"

  if (currentStep && (!stepName || currentStep.name === stepName)) {
    attachSkipResultToStep(currentStep, ev, message)
    finalizeStep(ev.timestamp, OperationStatus.Skipped)
    return
  }

  if (stepName) {
    const target = findFlowStepActivity(activities, stepName)
    if (target) {
      attachSkipResultToStep(target, ev, message)
      return
    }
  }

  activities.push({
    id: `lifecycle:${activities.length}`,
    name: stepName ?? "skipped",
    status: OperationStatus.Skipped,
    startedAt: ev.timestamp,
    endedAt: ev.timestamp,
    durationMs: numField(ev.data, "durationMs") ?? 0,
    events: [ev]
  })
}

function groupSyncExecuteActivities(events: OperationEvent[]): OperationActivity[] {
  const METADATA_STEP = "metadataSync"
  const activities: OperationActivity[] = []
  let currentStep: OperationActivity | null = null
  const openTables = new Map<string, OperationActivity>()
  const pipelineFailed = events.some(
    (ev) =>
      ev.type === EventType.SyncExecuteFailed ||
      ev.type === EventType.SyncExecuteStepFailed ||
      (ev.type === EventType.SyncExecuteCompleted && syncExecuteCompletedHasWarnings(ev.data))
  )

  const failOpenTables = (endTs: string, reason?: string): void => {
    for (const child of openTables.values()) {
      child.status = OperationStatus.Failed
      child.endedAt = endTs
      child.durationMs = durationOf(child.startedAt, endTs)
      child.error = reason ?? "Rolled back — not committed"
      child.summary = "Rolled back — not committed"
    }
    openTables.clear()
  }

  const finalizeStep = (endTs: string, status?: OperationStatus, error?: string): void => {
    if (!currentStep) return
    if (currentStep.name === METADATA_STEP && status === OperationStatus.Failed) {
      failOpenTables(endTs, error ?? "Rolled back — not committed")
    }
    currentStep.endedAt = endTs
    currentStep.durationMs = durationOf(currentStep.startedAt, endTs)
    if (status) currentStep.status = status
    else if (currentStep.status === OperationStatus.Running) currentStep.status = OperationStatus.Success
    if (error) currentStep.error = error
    currentStep = null
    openTables.clear()
  }

  const openFlowStep = (stepName: string, ev: OperationEvent): void => {
    finalizeStep(ev.timestamp)
    const stepSummary = syncExecuteStepSummary(stepName)
    currentStep = {
      id: `estep:${activities.length}`,
      name: stepName,
      status: OperationStatus.Running,
      startedAt: ev.timestamp,
      endedAt: null,
      durationMs: null,
      events: [ev],
      ...(stepSummary ? { summary: stepSummary } : {}),
      ...(stepName === METADATA_STEP ? { children: [] as OperationActivity[] } : {})
    }
    activities.push(currentStep)
  }

  const pushLifecycleActivity = (ev: OperationEvent): void => {
    const type = ev.type
    let name = type.replace(/^sync\.execute\./, "")
    let status: OperationStatus = OperationStatus.Success
    let summary: string | undefined
    let error: string | undefined

    if (type === EventType.SyncExecuteStarted) {
      name = "started"
      const source = strField(ev.data, "source")
      const target = strField(ev.data, "target")
      summary = source && target ? `${source} → ${target}` : undefined
    } else if (type === EventType.SyncExecuteCompleted) {
      name = "completed"
      const applied = ev.data["applied"] as Record<string, unknown> | undefined
      if (applied) {
        summary = `${applied["insert"] ?? 0} ins · ${applied["update"] ?? 0} upd · ${applied["delete"] ?? 0} del`
      }
      const warnings = ev.data["warnings"] as Array<{ step: string; error: string }> | undefined
      if (warnings && warnings.length > 0) {
        status = OperationStatus.Failed
        error = warnings.map((w) => `${w.step}: ${w.error}`).join("; ")
        summary = summary ? `${summary} · ${warnings.length} deploy failure(s)` : `${warnings.length} deploy failure(s)`
      }
    } else if (type === EventType.SyncExecuteFailed) {
      name = "failed"
      status = OperationStatus.Failed
      error = strField(ev.data, "error") ?? undefined
      summary = error
    }

    activities.push({
      id: `lifecycle:${activities.length}`,
      name,
      status,
      startedAt: ev.timestamp,
      endedAt: ev.timestamp,
      durationMs: numField(ev.data, "durationMs") ?? 0,
      ...(summary ? { summary } : {}),
      ...(error ? { error } : {}),
      events: [ev]
    })
  }

  const attachToMetadataStep = (ev: OperationEvent): void => {
    if (currentStep?.name === METADATA_STEP) {
      currentStep.events.push(ev)
    } else if (currentStep) {
      currentStep.events.push(ev)
    }
  }

  for (const ev of events) {
    const t = ev.type

    if (
      t === EventType.SyncExecuteStarted ||
      t === EventType.SyncExecuteCompleted ||
      t === EventType.SyncExecuteFailed
    ) {
      finalizeStep(ev.timestamp, t === EventType.SyncExecuteFailed ? OperationStatus.Failed : undefined)
      if (pipelineFailed && openTables.size > 0) {
        failOpenTables(ev.timestamp)
      }
      pushLifecycleActivity(ev)
      continue
    }

    if (t === EventType.SyncExecuteSkipped) {
      if (pipelineFailed && openTables.size > 0) {
        failOpenTables(ev.timestamp)
      }
      applyExecuteSkipped(ev, activities, currentStep, finalizeStep)
      continue
    }

    if (
      t === EventType.SyncExecuteArchiveSkipped ||
      t === EventType.SyncExecuteArchiveProbeBatch ||
      t === EventType.SyncExecuteArchiveProbe
    ) {
      attachToMetadataStep(ev)
      continue
    }

    if (t === EventType.SyncExecuteStep) {
      const stepName = strField(ev.data, "step") ?? "step"
      if (stepName === `${METADATA_STEP}-done`) {
        if (currentStep?.name === METADATA_STEP) {
          currentStep.events.push(ev)
          finalizeStep(ev.timestamp, OperationStatus.Success)
        }
        openFlowStep(stepName, ev)
        finalizeStep(ev.timestamp, OperationStatus.Success)
        continue
      }
      openFlowStep(stepName, ev)
      continue
    }

    if (t === EventType.SyncExecuteStepFailed) {
      const stepName = strField(ev.data, "step") ?? "step"
      const errMsg = strField(ev.data, "error") ?? OperationStatus.Failed
      if (currentStep && (currentStep.name === stepName || stepName === METADATA_STEP)) {
        currentStep.events.push(ev)
        finalizeStep(ev.timestamp, OperationStatus.Failed, errMsg)
      } else {
        activities.push({
          id: `estep:${activities.length}`,
          name: stepName,
          status: OperationStatus.Failed,
          startedAt: ev.timestamp,
          endedAt: ev.timestamp,
          durationMs: 0,
          error: errMsg,
          summary: syncExecuteStepSummary(stepName),
          events: [ev]
        })
      }
      continue
    }

    if (t === EventType.SyncExecuteTableStart) {
      const tableName = strField(ev.data, "table") ?? "table"
      const op = strField(ev.data, "op") ?? "apply"
      const rows = numField(ev.data, "rowsTotal")
      if (currentStep?.name === METADATA_STEP) {
        currentStep.events.push(ev)
        const child: OperationActivity = {
          id: `etbl:${tableName}:${currentStep.children?.length ?? 0}`,
          name: tableName,
          status: OperationStatus.Running,
          startedAt: ev.timestamp,
          endedAt: null,
          durationMs: null,
          summary: `${op}${rows != null ? ` · ${rows} row(s)` : ""}`,
          events: [ev]
        }
        if (!currentStep.children) currentStep.children = []
        currentStep.children.push(child)
        openTables.set(tableName, child)
        continue
      }
      attachToMetadataStep(ev)
      continue
    }

    if (t === EventType.SyncExecuteTableDone) {
      const tableName = strField(ev.data, "table") ?? ""
      const child = openTables.get(tableName)
      if (child) {
        child.events.push(ev)
        child.endedAt = ev.timestamp
        child.durationMs = durationOf(child.startedAt, ev.timestamp)
        child.status = OperationStatus.Success
        const applied = numField(ev.data, "rowsApplied")
        if (applied != null) child.summary = `${applied} row(s) committed`
        openTables.delete(tableName)
        currentStep?.events.push(ev)
        continue
      }
      attachToMetadataStep(ev)
      continue
    }

    if (currentStep) {
      if (t.endsWith(".sql")) {
        currentStep.events.push(ev)
        continue
      }
      currentStep.events.push(ev)
      continue
    }

    if (t.endsWith(".sql")) {
      activities.push({
        id: `sql:${activities.length}`,
        name: `SQL · ${strField(ev.data, "label") ?? "query"}`,
        status: ev.data["error"] ? OperationStatus.Failed : OperationStatus.Success,
        startedAt: ev.timestamp,
        endedAt: ev.timestamp,
        durationMs: numField(ev.data, "durationMs"),
        summary: strField(ev.data, "connection") ?? undefined,
        events: [ev],
      })
      continue
    }
  }

  const lastTs = events[events.length - 1]?.timestamp ?? new Date().toISOString()
  if (currentStep) {
    if (pipelineFailed && currentStep.status === OperationStatus.Running) {
      finalizeStep(lastTs, OperationStatus.Failed)
    } else {
      finalizeStep(lastTs)
    }
  } else if (pipelineFailed && openTables.size > 0) {
    failOpenTables(lastTs)
  }

  return activities
}
