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

export function readSqlTraceFields(data: Record<string, unknown>): SqlTraceFields | null {
  if (typeof data["sql"] !== "string" && typeof data["label"] !== "string") return null
  return {
    label: typeof data["label"] === "string" ? data["label"] : "query",
    connection: typeof data["connection"] === "string" ? data["connection"] : "?",
    sql: typeof data["sql"] === "string" ? data["sql"] : "",
    sqlLength: typeof data["sqlLength"] === "number" ? data["sqlLength"] : undefined,
    sqlLogId: typeof data["sqlLogId"] === "number" ? data["sqlLogId"] : null,
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
