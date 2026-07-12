export type PreviewTableStatus = "pending" | "running" | "done" | "failed"

export interface PreviewTableProgress {
  insert: number
  update: number
  delete: number
  status: PreviewTableStatus
  error?: string
}

export interface EnvSyncPreviewProgress {
  status: "running" | "done" | "failed"
  entityType: string
  entityId: string
  source: string
  target: string
  currentTable: string | null
  tableIndex: number | null
  tableTotal: number | null
  tables: Record<string, PreviewTableProgress>
  message: string | null
  error: string | null
}

export function createPreviewProgress(args: {
  entityType: string
  entityId: string
  source: string
  target: string
}): EnvSyncPreviewProgress {
  return {
    status: "running",
    entityType: args.entityType,
    entityId: args.entityId,
    source: args.source,
    target: args.target,
    currentTable: null,
    tableIndex: null,
    tableTotal: null,
    tables: {},
    message: "Starting preview…",
    error: null,
  }
}

function num(data: Record<string, unknown>, key: string): number {
  const v = data[key]
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function str(data: Record<string, unknown>, key: string): string {
  const v = data[key]
  return v == null ? "" : String(v)
}

/** Reduce sync.preview.* SSE events into widget preview progress. */
export function reduceEnvSyncPreviewProgress(
  prev: EnvSyncPreviewProgress | null,
  type: string,
  data: Record<string, unknown>,
): EnvSyncPreviewProgress | null {
  if (!prev) return prev

  const next: EnvSyncPreviewProgress = {
    ...prev,
    tables: { ...prev.tables },
  }

  switch (type) {
    case "sync.preview.started":
      next.status = "running"
      next.message = `Previewing ${str(data, "entityType")} ${str(data, "entityId")}`
      break
    case "sync.preview.table.start": {
      const table = str(data, "table")
      next.currentTable = table
      next.tableIndex = num(data, "tableIndex") || null
      next.tableTotal = num(data, "tableTotal") || null
      next.tables[table] = { insert: 0, update: 0, delete: 0, status: "running" }
      next.message = `Diffing ${table.split(".").pop() ?? table}…`
      break
    }
    case "sync.preview.table.done": {
      const table = str(data, "table")
      next.tables[table] = {
        insert: num(data, "insert"),
        update: num(data, "update"),
        delete: num(data, "delete"),
        status: "done",
      }
      next.message = `${table.split(".").pop() ?? table}: +${num(data, "insert")} ~${num(data, "update")} -${num(data, "delete")}`
      break
    }
    case "sync.preview.table.failed": {
      const table = str(data, "table")
      const error = str(data, "error") || "failed"
      next.tables[table] = {
        insert: 0,
        update: 0,
        delete: 0,
        status: "failed",
        error,
      }
      next.status = "running"
      next.message = `${table.split(".").pop() ?? table} failed: ${error}`
      break
    }
    case "sync.preview.completed": {
      next.status = "done"
      next.currentTable = null
      const totals = data["totals"] as Record<string, unknown> | undefined
      if (totals) {
        next.message = `Preview complete — +${num(totals, "insert")} ~${num(totals, "update")} -${num(totals, "delete")}`
      } else {
        next.message = "Preview complete"
      }
      break
    }
    case "sync.preview.failed":
      next.status = "failed"
      next.error = str(data, "error") || "Preview failed"
      next.message = next.error
      break
    default:
      return prev
  }

  return next
}

export function previewTablesDone(progress: EnvSyncPreviewProgress): number {
  return Object.values(progress.tables).filter((row) => row.status === "done").length
}

export function previewTablesFailed(progress: EnvSyncPreviewProgress): number {
  return Object.values(progress.tables).filter((row) => row.status === "failed").length
}
