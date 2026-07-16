/** Returns true for any sync SQL telemetry event type. */
export function isSyncSqlEventType(type: string): boolean {
  return type.endsWith(".sql") && type.startsWith("sync.")
}

export interface SqlTraceFields {
  label: string
  connection: string
  sql: string
  sqlLength?: number
  sqlLogId?: number | null
  rowCount?: number | null
  durationMs?: number | null
  error?: string | null
  scope?: string | null
}

function coerceSqlLogId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value)
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

function coerceSqlText(value: unknown): string {
  if (typeof value === "string") return value
  return ""
}

/** True when the modal can show or fetch statement text. */
export function hasSqlTraceContent(fields: SqlTraceFields): boolean {
  return fields.sql.trim().length > 0 || fields.sqlLogId != null
}

export function readSqlTraceFields(data: Record<string, unknown>): SqlTraceFields | null {
  const sql = coerceSqlText(data["sql"] ?? data["sqlPreview"] ?? data["command"])
  const sqlLogId = coerceSqlLogId(data["sqlLogId"])
  const label = typeof data["label"] === "string" ? data["label"] : null
  if (!label && !sql && sqlLogId == null) return null

  return {
    label: label ?? "query",
    connection: typeof data["connection"] === "string" ? data["connection"] : "?",
    sql,
    sqlLength: typeof data["sqlLength"] === "number" ? data["sqlLength"] : undefined,
    sqlLogId,
    rowCount: typeof data["rowCount"] === "number" ? data["rowCount"] : null,
    durationMs: typeof data["durationMs"] === "number" ? data["durationMs"] : null,
    error: typeof data["error"] === "string" ? data["error"] : null,
    scope: typeof data["scope"] === "string" ? data["scope"] : null,
  }
}

export function formatSqlTraceMeta(fields: SqlTraceFields): string {
  const parts = [fields.label, fields.connection]
  if (fields.rowCount != null) parts.push(`${fields.rowCount} rows`)
  if (fields.durationMs != null) parts.push(`${fields.durationMs}ms`)
  if (fields.error) parts.push(`error: ${fields.error}`)
  return parts.join(" · ")
}

/** Normalize any SQL/code payload before rendering or copying. */
export function normalizeSqlTraceText(value: unknown): string {
  if (typeof value === "string") return value
  if (value == null) return ""
  return String(value)
}
