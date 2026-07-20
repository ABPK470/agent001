/**
 * Kind-specific SQL that lists schema-qualified base tables for Bridge target pickers.
 * Returns rows with a single string column `name`.
 */

import type { ConnectorKindId } from "@mia/shared-types"

/** SQL that yields `{ name: string }` rows, or null when the kind has no SQL table catalog. */
export function listTablesSql(kind: ConnectorKindId): string | null {
  if (kind === "mssql") {
    return `
SELECT TABLE_SCHEMA + N'.' + TABLE_NAME AS name
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_TYPE = N'BASE TABLE'
ORDER BY TABLE_SCHEMA, TABLE_NAME
`.trim()
  }
  if (kind === "postgres") {
    return `
SELECT table_schema || '.' || table_name AS name
FROM information_schema.tables
WHERE table_type = 'BASE TABLE'
  AND table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name
`.trim()
  }
  if (kind === "databricks") {
    return `
SELECT table_schema || '.' || table_name AS name
FROM information_schema.tables
WHERE table_type = 'BASE TABLE'
ORDER BY table_schema, table_name
`.trim()
  }
  if (kind === "hive") {
    // HiveQL — tab_name only; schema is the current database.
    return `SHOW TABLES`
  }
  return null
}

/** Normalize a driver row into a schema-qualified (or bare) table name. */
export function tableNameFromRow(row: Record<string, unknown>): string | null {
  const candidates = [
    row["name"],
    row["NAME"],
    row["table_name"],
    row["TABLE_NAME"],
    row["tab_name"],
    row["tabName"],
  ]
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  // Hive SHOW TABLES sometimes returns { database, tableName, isTemporary }
  const db = row["database"] ?? row["Database"]
  const table = row["tableName"] ?? row["tab_name"] ?? row["table"]
  if (typeof table === "string" && table.trim()) {
    if (typeof db === "string" && db.trim()) return `${db.trim()}.${table.trim()}`
    return table.trim()
  }
  return null
}
