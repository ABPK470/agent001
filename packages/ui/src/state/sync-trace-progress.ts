/**
 * Coalesced sync progress for chat trace — maps sync.* SSE events into a
 * single updating `sync-progress` trace entry per tool invocation.
 */

import { readSseEntityId, type TraceEntry } from "@mia/shared-types"

export const SYNC_TRACE_TOOLS = new Set([
  "sync_preview",
  "sync_diff_scan",
  "sync_execute",
  "compare_catalogs"
])

export type SyncProgressLevel = "info" | "warn" | "error"

export interface SyncProgressState {
  readonly invocationId: string
  readonly tool: string
  status: "running" | "done" | "error"
  headline: string
  detail: string | null
  level: SyncProgressLevel
  sql: {
    label: string
    connection: string
    preview: string
    rowCount: number | null
    durationMs: number | null
  } | null
  lastTable: {
    name: string
    index?: number
    total?: number
    insert?: number
    update?: number
    delete?: number
    status?: "running" | "done" | "error"
  } | null
  result: string | null
}

function str(data: Record<string, unknown>, key: string): string {
  const v = data[key]
  return v == null ? "" : String(v)
}

function num(data: Record<string, unknown>, key: string): number | null {
  const v = data[key]
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function formatTableProgress(table: string, index?: number, total?: number): string {
  const short = table.split(".").pop() ?? table
  if (index != null && total != null && total > 0) {
    return `${short} (${index}/${total})`
  }
  return short
}

function formatEntityHeadline(
  entityType: string,
  entityId: string,
  index?: number | null,
  total?: number | null
): string {
  const progress =
    index != null && total != null && total > 0 ? ` (${index}/${total})` : ""
  return `Previewing ${entityType} id ${entityId}${progress}`
}

export function createSyncProgressState(invocationId: string, tool: string): SyncProgressState {
  return {
    invocationId,
    tool,
    status: "running",
    headline: "Starting…",
    detail: null,
    level: "info",
    sql: null,
    lastTable: null,
    result: null
  }
}

function applySyncSqlTrace(
  next: SyncProgressState,
  data: Record<string, unknown>,
): SyncProgressState {
  const sql = str(data, "sql")
  next.sql = {
    label: str(data, "label") || "query",
    connection: str(data, "connection"),
    preview: sql,
    rowCount: num(data, "rowCount"),
    durationMs: num(data, "durationMs"),
  }
  const rows = next.sql.rowCount != null ? `${next.sql.rowCount} rows` : "?"
  const dur = next.sql.durationMs != null ? ` · ${next.sql.durationMs}ms` : ""
  const scope = str(data, "scope")
  next.detail = `${next.sql.label}${scope ? ` (${scope})` : ""} · ${next.sql.connection} · ${rows}${dur}`
  return next
}

export function reduceSyncSseEvent(
  state: SyncProgressState,
  type: string,
  data: Record<string, unknown>
): SyncProgressState {
  const next = { ...state, lastTable: state.lastTable ? { ...state.lastTable } : null, sql: state.sql ? { ...state.sql } : null }

  switch (type) {
    case "sync.scan.discovered": {
      const entityType = str(data, "entityType")
      const source = str(data, "source")
      const target = str(data, "target")
      const totalOnSource = num(data, "totalOnSource")
      const toScan = num(data, "toScan")
      const sampled = Boolean(data["sampled"])
      const totalLabel = totalOnSource != null ? totalOnSource.toLocaleString() : "?"
      const scanLabel = toScan != null ? toScan.toLocaleString() : "?"
      next.headline = sampled
        ? `Found ${totalLabel} ${entityType} on ${source}, scanning ${scanLabel}`
        : `Found ${totalLabel} ${entityType} on ${source}`
      next.detail = `Hash preview · ${source} → ${target}`
      next.lastTable = null
      break
    }
    case "sync.scan.entity.start": {
      const entityIndex = num(data, "entityIndex")
      const entityTotal = num(data, "entityTotal")
      const entityType = str(data, "entityType")
      const entityId = readSseEntityId(data) ?? ""
      const entityLabel = str(data, "entityLabel")
      const source = str(data, "source")
      const target = str(data, "target")
      const idPart = entityLabel ? `${entityId} (${entityLabel})` : entityId
      const progress =
        entityIndex != null && entityTotal != null && entityTotal > 0
          ? ` (${entityIndex}/${entityTotal})`
          : ""
      next.headline = `Previewing ${entityType} id ${idPart}${progress}`
      next.detail = `Hash preview · ${source} → ${target}`
      next.lastTable = null
      break
    }
    case "sync.preview.started": {
      const entityType = str(data, "entityType")
      const entityId = readSseEntityId(data) ?? ""
      const source = str(data, "source")
      const target = str(data, "target")
      const scanIndex = num(data, "scanIndex")
      const scanTotal = num(data, "scanTotal")
      next.headline = formatEntityHeadline(
        entityType,
        entityId,
        state.tool === "sync_diff_scan" ? scanIndex : null,
        state.tool === "sync_diff_scan" ? scanTotal : null
      )
      next.detail = `Hash preview · ${source} → ${target}`
      break
    }
    case "sync.preview.table.start": {
      const table = str(data, "table")
      const tableIndex = num(data, "tableIndex")
      const tableTotal = num(data, "tableTotal")
      const predicate = str(data, "predicate")
      next.lastTable = {
        name: table,
        index: tableIndex ?? undefined,
        total: tableTotal ?? undefined,
        status: "running"
      }
      const tbl = formatTableProgress(table, tableIndex ?? undefined, tableTotal ?? undefined)
      next.detail = `Diffing ${tbl}${predicate ? ` · ${truncate(predicate, 80)}` : ""}`
      break
    }
    case "sync.preview.table.done": {
      const table = str(data, "table")
      const tableIndex = num(data, "tableIndex")
      const tableTotal = num(data, "tableTotal")
      next.lastTable = {
        name: table,
        index: tableIndex ?? undefined,
        total: tableTotal ?? undefined,
        insert: num(data, "insert") ?? 0,
        update: num(data, "update") ?? 0,
        delete: num(data, "delete") ?? 0,
        status: "done"
      }
      const m = next.lastTable
      const tbl = formatTableProgress(table, m.index, m.total)
      next.detail = `${tbl}: +${m.insert ?? 0} ~${m.update ?? 0} -${m.delete ?? 0}`
      break
    }
    case "sync.preview.table.failed": {
      const table = str(data, "table")
      next.level = "error"
      next.lastTable = { name: table, status: "error" }
      next.detail = `${table}: ${str(data, "error") || "failed"}`
      break
    }
    case "sync.preview.sql":
    case "sync.execute.sql":
    case "sync.catalog.sql":
    case "sync.discovery.sql":
      applySyncSqlTrace(next, data)
      break
    case "sync.retry": {
      next.level = "warn"
      const phase = str(data, "phase")
      const conn = str(data, "connection")
      const attempt = num(data, "attempt") ?? 1
      const max = num(data, "maxAttempts") ?? 3
      const err = truncate(str(data, "error") || "connection error", 80)
      next.detail = `${phase === "catalog" ? "Catalog" : "Query"} retry ${conn} (${attempt}/${max}): ${err}`
      break
    }
    case "sync.preview.completed": {
      next.status = "done"
      const planId = str(data, "planId").slice(0, 8)
      const totals = data["totals"] as Record<string, unknown> | undefined
      if (totals) {
        next.result = `Preview complete — plan ${planId}: +${num(totals, "insert") ?? 0} ~${num(totals, "update") ?? 0} -${num(totals, "delete") ?? 0}`
      } else {
        next.result = `Preview complete — plan ${planId}`
      }
      break
    }
    case "sync.preview.failed": {
      next.status = "error"
      next.level = "error"
      next.result = `Preview failed: ${str(data, "error") || "unknown error"}`
      break
    }
    case "sync.execute.started": {
      next.headline = "Executing sync plan"
      next.detail = `${str(data, "source")} → ${str(data, "target")}`
      break
    }
    case "sync.execute.completed": {
      const warnings = Array.isArray(data["warnings"]) ? (data["warnings"] as unknown[]) : []
      next.status = warnings.length > 0 ? "error" : "done"
      next.level = warnings.length > 0 ? "warn" : next.level
      next.result = warnings.length > 0
        ? `Execute finished with ${warnings.length} deploy step failure(s)`
        : "Sync execute completed"
      break
    }
    case "sync.execute.failed": {
      next.status = "error"
      next.level = "error"
      next.result = `Execute failed: ${str(data, "error") || "unknown"}`
      break
    }
    default:
      break
  }

  return next
}

export function syncProgressToTraceEntry(state: SyncProgressState): TraceEntry {
  return {
    kind: "sync-progress",
    invocationId: state.invocationId,
    tool: state.tool,
    status: state.status,
    headline: state.headline,
    detail: state.detail ?? undefined,
    level: state.level,
    sql: state.sql ?? undefined,
    lastTable: state.lastTable ?? undefined,
    result: state.result ?? undefined
  }
}

export function finalizeSyncProgress(
  state: SyncProgressState,
  resultText: string | null,
  failed: boolean
): SyncProgressState {
  return {
    ...state,
    status: failed ? "error" : "done",
    level: failed ? "error" : state.level,
    result: resultText ?? state.result
  }
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1) + "…"
}
