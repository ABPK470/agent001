/**
 * Pure presentation logic for operation / pipeline data.
 * Shared by Pipelines and Activity widgets — no UI components.
 */

import type { OperationActivity, OperationEvent, OperationPipeline } from "../api"
import { OperationKind, OperationStatus } from "../api"
import { isSyncSqlEventType } from "../sync-sql-trace"
import { readToolIoFromEvent } from "../tool-call-io"

export function fmtDuration(ms: number | null): string {
  if (ms == null) return "—"
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

export function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString(undefined, { hour12: false })
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

export function formatPipelineSubtitle(subtitle: string): string {
  return subtitle.replace(
    /\bdef\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)/g,
    (_, iso: string) => `def ${fmtDateTime(iso)}`,
  )
}

export function dayLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "Unknown"
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const day = new Date(d)
  day.setHours(0, 0, 0, 0)
  if (day.getTime() === today.getTime()) return "Today"
  if (day.getTime() === yesterday.getTime()) return "Yesterday"
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

export function matchesPipeline(p: OperationPipeline, needle: string): boolean {
  if (!needle) return true
  const activityHay = (activities: OperationActivity[]): string[] =>
    activities.flatMap((a) => [
      a.name,
      a.summary ?? "",
      a.error ?? "",
      ...(a.children?.flatMap((c) => [c.name, c.summary ?? "", c.error ?? ""]) ?? []),
      ...a.events.map((e) => e.type),
    ])

  const hay = [
    p.title,
    p.subtitle ?? "",
    p.id,
    p.error ?? "",
    p.planId ?? "",
    ...activityHay(p.activities),
  ]
    .join(" ")
    .toLowerCase()
  return hay.includes(needle)
}

export function pipelineActivityKey(pipelineId: string, activityId: string): string {
  return `${pipelineId}|${activityId}`
}

export function syncPlanIdFromPipeline(pipeline: OperationPipeline): string {
  return pipeline.planId ?? pipeline.id.replace(/:(preview|execute)$/, "")
}

export function humanizeToken(value: string): string {
  return value
    .replace(/[_\.]+/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

const EXEC_STEP_DESCRIPTIONS: Record<string, string> = {
  auditCheck: "Source audit gate before metadata sync (uspAuditRunCheck).",
  targetLock: "Lock the contract while deployment is in progress.",
  metadataSync: "Apply metadata row changes on the target environment.",
  metadataSyncDone: "Metadata transaction committed successfully.",
  "metadataSync-done": "Metadata transaction committed successfully.",
  pipelineRegister: "Register or refresh the pipeline in the Agent service.",
  contractUndeploy: "Remove previously deployed artifacts marked for replacement.",
  contractUnlockAfterUndeploy: "Release the contract lock after undeploy completes.",
  auditCheckPreDeploy: "Re-run source audit after undeploy, before physical deploy.",
  contractLockForDeploy: "Acquire the deployment lock for the build phase.",
  contractPreScript: "Run pre-deployment SQL scripts.",
  contractCreateDatasetStage: "Create or alter stage datasets.",
  contractCreateDatasetArchive: "Create or alter archive datasets.",
  contractCreateDatasetList: "Create or alter list datasets.",
  contractCreateDatasetDim: "Create or alter dimension datasets.",
  contractCreateDatasetFact: "Create or alter fact datasets.",
  contractCreateFks: "Reconcile foreign keys for deployed datasets.",
  contractDeployEtl: "Create or update ETL procedures, views, and functions.",
  contractDeployRoutine: "Create or update routines and triggers.",
  handleDependencies: "Refresh dependent objects after metadata changes.",
  metaRefresh: "Refresh gate metadata on the target service.",
  pipelineStart: "Trigger the registered pipeline on the target service.",
  setSyncDate: "Stamp the target row sync date.",
  setDeployDate: "Stamp the target row deploy date.",
  syncDate: "Stamp the target row sync date.",
  deployDate: "Stamp the target row deploy date.",
  contractDeploy: "Run the full contract deployment sequence.",
  datasetDeploy: "Trigger dataset deployment in ETL.",
  rulesDeploy: "Trigger rule deployment in ETL.",
}

export function activityPipelineKind(pipelineKind: OperationKind, parentPhaseId?: string): OperationKind {
  if (pipelineKind !== OperationKind.SyncRun) return pipelineKind
  if (parentPhaseId === "phase:preview") return OperationKind.SyncPreview
  if (parentPhaseId === "phase:execute") return OperationKind.SyncExecute
  return pipelineKind
}

export function formatActivityName(pipelineKind: OperationKind, activity: OperationActivity): string {
  if (pipelineKind === OperationKind.SyncExecute) {
    if (activity.name === "Preflight checks") return activity.name
    if (activity.name === "started") return "Started"
    if (activity.name === "completed") return "Completed"
    if (activity.name === "failed") return "Failed"
    if (activity.name === "phases" || activity.name === "other events" || activity.name.startsWith("tbl:"))
      return activity.name
    if (activity.name.includes(" (")) return activity.name
    if (activity.name === "skipped" || activity.name === "Execute skipped") return "Execute skipped"
    if (activity.name === "result") return "Result"
    return humanizeToken(activity.name)
  }
  if (pipelineKind === OperationKind.SyncPreview) {
    if (activity.name === "Preflight checks") return activity.name
    if (activity.name === "started") return "Started"
    if (activity.name === "completed") return "Completed"
    if (activity.name === "failed") return "Failed"
    return activity.name
  }
  if (pipelineKind === OperationKind.AgentRun) {
    if (activity.name === "Sync preview" || activity.name === "Sync execute") return activity.name
    if (activity.name === "queued") return "Queued"
    if (activity.name === "started") return "Started"
    if (activity.name === "completed") return "Completed"
    if (activity.name === "failed") return "Failed"
    if (activity.name === "cancelled") return "Cancelled"
    return humanizeToken(activity.name)
  }
  return activity.name
}

function flowStepDescription(activity: OperationActivity): string | undefined {
  return (
    EXEC_STEP_DESCRIPTIONS[activity.name] ??
    EXEC_STEP_DESCRIPTIONS[activity.name.replace(/-done$/, "Done")] ??
    activity.summary
  )
}

export function effectiveActivityStatus(
  activity: OperationActivity,
  pipelineStatus: OperationStatus,
  parentStatus?: OperationStatus,
): OperationStatus {
  if (activity.status !== OperationStatus.Running) return activity.status
  const parentTerminal =
    parentStatus === OperationStatus.Failed ||
    parentStatus === OperationStatus.Skipped ||
    parentStatus === OperationStatus.Cancelled
      ? parentStatus
      : null
  const pipelineTerminal =
    pipelineStatus === OperationStatus.Failed ||
    pipelineStatus === OperationStatus.Skipped ||
    pipelineStatus === OperationStatus.Cancelled
      ? pipelineStatus
      : null
  return parentTerminal ?? pipelineTerminal ?? activity.status
}

export function defaultActivitySummary(
  pipelineKind: OperationKind,
  activity: OperationActivity,
): string | undefined {
  if (activity.name === "result") return undefined
  if (activity.status === "skipped" && activity.children?.some((c) => c.name === "result")) {
    return flowStepDescription(activity)
  }
  if (activity.summary && activity.status !== "skipped") return activity.summary
  if (pipelineKind === OperationKind.SyncExecute) {
    if (activity.status === "skipped") return activity.error ?? undefined
    return (
      EXEC_STEP_DESCRIPTIONS[activity.name] ??
      EXEC_STEP_DESCRIPTIONS[activity.name.replace(/-done$/, "Done")] ??
      undefined
    )
  }
  if (pipelineKind === OperationKind.AgentRun) {
    const planId = activity.details?.["planId"]
    if (typeof planId === "string" && activity.name === "Sync preview") {
      return `Delegated preview · plan ${planId.slice(0, 8)}`
    }
    if (typeof planId === "string" && activity.name === "Sync execute") {
      return `Delegated execute · plan ${planId.slice(0, 8)}`
    }
  }
  return undefined
}

export function isSyncExecuteFlowStep(kind: OperationKind, activity: OperationActivity): boolean {
  if (kind !== OperationKind.SyncExecute) return false
  if (activity.id.startsWith("lifecycle:")) return false
  if (activity.name.startsWith("tbl:")) return false
  return ![
    "started",
    "completed",
    "failed",
    "Preflight checks",
    "skipped",
    "result",
    "Execute skipped",
  ].includes(activity.name)
}

export function shouldHideSyncExecuteStepEvent(
  kind: OperationKind,
  activity: OperationActivity,
  ev: OperationEvent,
): boolean {
  return isSyncExecuteFlowStep(kind, activity) && ev.type === "sync.execute.step"
}

export function isSqlOnlyActivity(activity: OperationActivity): boolean {
  return (
    activity.name.startsWith("SQL · ") &&
    activity.events.length === 1 &&
    isSyncSqlEventType(activity.events[0]!.type) &&
    (activity.children?.length ?? 0) === 0
  )
}

export function formatEventLabel(ev: OperationEvent): string {
  switch (ev.type) {
    case "sync.preview.completed":
      return "Preview complete"
    case "sync.preview.table.start":
      return "Table scan"
    case "sync.preview.table.done":
      return "Table diff"
    case "sync.preview.table.failed":
      return "Table failed"
    case "sync.execute.started":
      return "Execute started"
    case "sync.execute.step":
      return "Step"
    case "sync.execute.step.failed":
      return "Step failed"
    case "sync.execute.table.start":
      return "Table apply"
    case "sync.execute.table.done":
      return "Table done"
    case "sync.execute.sql":
    case "sync.catalog.sql":
    case "sync.discovery.sql":
    case "sync.preview.sql":
      return "SQL"
    case "sync.execute.archive.probe":
      return "Archive probe"
    case "sync.execute.archive.probe.batch":
      return "Archive probe batch"
    case "sync.execute.archive.skipped":
      return "Archive skipped"
    case "sync.execute.completed":
      return "Execute complete"
    case "sync.execute.failed":
      return "Execute failed"
    case "sync.execute.skipped":
      return "Execute skipped"
    case "sync.proposer.run.started":
      return "Scan started"
    case "sync.proposer.run.completed":
      return "Scan completed"
    case "sync.proposer.run.failed":
      return "Scan failed"
    case "sync.proposer.run.cancelled":
      return "Scan cancelled"
    case "sync.proposal.created":
      return "Proposal created"
    case "step.started":
      return "Tool call"
    case "step.completed":
      return "Tool result"
    case "step.failed":
      return "Tool failed"
    default:
      return ev.type
  }
}

function resolveInlineToolName(data: Record<string, unknown>): string {
  const action = data["action"]
  if (typeof action === "string" && action.length > 0) return action
  const tool = data["tool"]
  if (typeof tool === "string" && tool.length > 0) return tool
  return "step"
}

export function pickEventSummary(ev: OperationEvent): string {
  if (ev.type === "step.started") {
    const toolIo = readToolIoFromEvent(ev)
    return toolIo?.argsSummary ?? resolveInlineToolName(ev.data)
  }
  if (ev.type === "step.completed") {
    const toolIo = readToolIoFromEvent(ev)
    const dur = ev.data["durationMs"]
    const durPart = typeof dur === "number" ? `${dur}ms` : null
    const outPart = toolIo?.outputText ?? null
    return [outPart, durPart].filter(Boolean).join(" · ") || "completed"
  }
  if (ev.type === "step.failed") {
    const err = typeof ev.data["error"] === "string" ? ev.data["error"] : "step failed"
    return err
  }
  if (ev.type === "sync.execute.step") return ""
  if (ev.type === "sync.execute.step.failed") {
    const step = typeof ev.data["step"] === "string" ? String(ev.data["step"]) : "step"
    const op = typeof ev.data["op"] === "string" ? String(ev.data["op"]) : null
    const table = typeof ev.data["table"] === "string" ? String(ev.data["table"]) : null
    const error =
      typeof ev.data["cause"] === "string"
        ? String(ev.data["cause"])
        : typeof ev.data["error"] === "string"
          ? String(ev.data["error"])
          : "unknown error"
    return [humanizeToken(step), op, table, error].filter(Boolean).join(" — ")
  }
  if (ev.type === "sync.execute.skipped") {
    const step = typeof ev.data["step"] === "string" ? humanizeToken(String(ev.data["step"])) : null
    const message = typeof ev.data["message"] === "string" ? String(ev.data["message"]) : null
    return [step, message].filter(Boolean).join(" — ") || "Skipped"
  }
  if (ev.type === "sync.execute.failed") {
    const step = typeof ev.data["step"] === "string" ? humanizeToken(String(ev.data["step"])) : null
    const op = typeof ev.data["op"] === "string" ? String(ev.data["op"]) : null
    const table = typeof ev.data["table"] === "string" ? String(ev.data["table"]) : null
    const error =
      typeof ev.data["cause"] === "string"
        ? String(ev.data["cause"])
        : typeof ev.data["error"] === "string"
          ? String(ev.data["error"])
          : "unknown error"
    return [step, op, table, error].filter(Boolean).join(" — ")
  }
  if (ev.type === "sync.execute.started") {
    return `${ev.data["source"] ?? "?"} → ${ev.data["target"] ?? "?"}`
  }
  if (ev.type === "sync.execute.completed") {
    const applied = ev.data["applied"]
    if (applied && typeof applied === "object") {
      const counts = applied as Record<string, unknown>
      const base = `${counts["insert"] ?? 0} ins · ${counts["update"] ?? 0} upd · ${counts["delete"] ?? 0} del`
      const warnings = ev.data["warnings"]
      if (Array.isArray(warnings) && warnings.length > 0) {
        return `${base} · ${warnings.length} deploy failure(s)`
      }
      return base
    }
  }
  if (ev.type === "sync.preview.started") {
    return `${ev.data["source"] ?? "?"} → ${ev.data["target"] ?? "?"}`
  }
  if (ev.type === "sync.preview.completed") {
    const totals = ev.data["totals"]
    if (totals && typeof totals === "object") {
      const counts = totals as Record<string, unknown>
      return `${counts["insert"] ?? 0} ins · ${counts["update"] ?? 0} upd · ${counts["delete"] ?? 0} del`
    }
  }
  if (ev.type === "sync.preview.table.done") {
    const counts =
      ev.data["counts"] && typeof ev.data["counts"] === "object"
        ? (ev.data["counts"] as Record<string, unknown>)
        : ev.data
    const ins = counts["insert"] ?? 0
    const upd = counts["update"] ?? 0
    const del = counts["delete"] ?? 0
    const table = ev.data["table"] ?? "table"
    const durationMs = ev.data["durationMs"]
    return `${table} · ${ins} ins · ${upd} upd · ${del} del${typeof durationMs === "number" ? ` · ${durationMs}ms` : ""}`
  }
  if (ev.type === "sync.preview.table.start") {
    const table = ev.data["table"] ?? "table"
    const predicate = ev.data["predicate"]
    return predicate && typeof predicate === "string" ? `${table} · ${predicate}` : String(table)
  }
  if (ev.type === "sync.execute.table.start") {
    const table = ev.data["table"] ?? "table"
    const op = ev.data["op"] ?? "apply"
    const rows = ev.data["rowsTotal"]
    return `${table} · ${op}${rows != null ? ` · ${rows} rows` : ""}`
  }
  if (ev.type === "sync.execute.table.done") {
    return `${ev.data["table"] ?? "table"} · ${ev.data["rowsApplied"] ?? "?"} rows applied`
  }
  if (ev.type.endsWith(".sql") && ev.type.startsWith("sync.")) {
    const sql = typeof ev.data["sql"] === "string" ? ev.data["sql"].trim() : ""
    if (sql) return sql
    const rowCount = ev.data["rowCount"]
    const durationMs = ev.data["durationMs"]
    const connection = ev.data["connection"]
    return [
      connection != null ? String(connection) : null,
      rowCount != null ? `${rowCount} rows` : null,
      durationMs != null ? `${durationMs}ms` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "SQL"
  }
  const d = ev.data
  const parts: string[] = []
  for (const key of [
    "table",
    "step",
    "op",
    "tool",
    "label",
    "sproc",
    "message",
    "rowsApplied",
    "rowCount",
    "durationMs",
    "cause",
    "error",
  ]) {
    const v = d[key]
    if (v == null) continue
    if (key === "durationMs" && typeof v === "number") parts.push(`${v}ms`)
    else if (key === "rowsApplied" && typeof v === "number") parts.push(`${v} rows`)
    else if (key === "rowCount" && typeof v === "number") parts.push(`${v} rows`)
    else if (typeof v === "string" || typeof v === "number") parts.push(String(v))
  }
  return parts.slice(0, 4).join(" · ")
}

export function statusLabel(status: OperationStatus): string {
  switch (status) {
    case "running":
      return "In progress"
    case "success":
      return "Done"
    case "failed":
      return "Failed"
    case "cancelled":
      return "Canceled"
    case "skipped":
      return "Skipped"
    default:
      return status
  }
}

export function shortId(id: string): string {
  if (id.length <= 10) return id
  return id.slice(0, 8)
}
