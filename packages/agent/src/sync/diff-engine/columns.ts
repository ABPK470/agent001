/**
 * Column discovery + per-row hash extraction for the diff engine.
 *
 * @module
 */

import type sql from "mssql"
import { hashExpr, qtable, runQueryWithRetry } from "./sql-helpers.js"
import {
    DETERMINISTIC_SESSION_PREFIX,
    META_EXCLUDED_COLUMNS,
    type HashColumn,
    type PkHashRow,
    type TableColumnInfo,
} from "./types.js"

/**
 * Discover the columns of a table that participate in the row-hash comparison.
 * Mirrors core.uspSyncObjectTran's column selection: skip computed columns,
 * skip meta columns (validFrom/validTo/isLocked/syncDate/deployDate),
 * skip the identity column (it's the PK and used for matching).
 */
export async function fetchTableColumns(
  pool: sql.ConnectionPool,
  qualifiedTable: string,
): Promise<TableColumnInfo> {
  const [schema, name] = qualifiedTable.split(".")
  const result = await runQueryWithRetry(pool, `
    SELECT
      c.name             AS columnName,
      c.is_computed      AS isComputed,
      c.is_identity      AS isIdentity,
      LOWER(ty.name)     AS systemType
    FROM sys.columns c
    JOIN sys.objects o  ON o.object_id = c.object_id
    JOIN sys.types ty   ON ty.user_type_id = c.user_type_id
    WHERE o.[type] = 'U'
      AND o.name = '${name!.replace(/'/g, "''")}'
      AND OBJECT_SCHEMA_NAME(c.object_id) = '${schema!.replace(/'/g, "''")}'
    ORDER BY c.column_id
  `, `fetchTableColumns(${qualifiedTable})`)
  const hashColumns: HashColumn[] = []
  let identityColumn: string | null = null
  for (const row of result.recordset as Array<{ columnName: string; isComputed: boolean; isIdentity: boolean; systemType: string }>) {
    if (row.isIdentity) { identityColumn = row.columnName; continue }
    if (row.isComputed) continue
    if (META_EXCLUDED_COLUMNS.has(row.columnName)) continue
    hashColumns.push({ name: row.columnName, systemType: row.systemType })
  }
  return { hashColumns, identityColumn }
}

/**
 * Fetch pk + per-row hash from a table, scoped by predicate.
 *
 * Hash is computed in SQL Server via:
 *   HASHBYTES('SHA2_256', CONCAT_WS('|', CAST(c1 AS NVARCHAR(MAX)), CAST(c2 AS NVARCHAR(MAX)), ...))
 *
 * NULLs are passed through CONCAT_WS naturally (treated as empty string with the separator skipped),
 * which means NULL == '' for hash purposes. Acceptable for ABI metadata — all non-nullable cols
 * in scope are stable, and nullables compare consistently across source/target.
 */
export async function fetchPkHash(
  pool: sql.ConnectionPool,
  qualifiedTable: string,
  predicate: string,
  pkColumns: string[],
  colInfo: TableColumnInfo,
): Promise<PkHashRow[]> {
  const pkSelect = pkColumns.map((c) => `[${c}]`).join(", ")
  const hashArgs = colInfo.hashColumns.map(hashExpr).join(", ")
  // No NOLOCK: dirty reads cause classification flapping between runs.
  // Session prefix pins LANGUAGE/DATEFORMAT/etc so CONVERT output is identical
  // across every TDS connection in the pool.
  const query =
    DETERMINISTIC_SESSION_PREFIX +
    `SELECT ${pkSelect}, ` +
    `HASHBYTES('SHA2_256', ISNULL(CONCAT_WS('|', ${hashArgs}), '')) AS rowHash ` +
    `FROM ${qtable(qualifiedTable)} WHERE ${predicate}`
  const result = await runQueryWithRetry(pool, query, `fetchPkHash(${qualifiedTable})`)
  return (result.recordset as Record<string, unknown>[]).map((row) => {
    const pkValues: Record<string, unknown> = {}
    for (const c of pkColumns) pkValues[c] = row[c]
    const pk = pkColumns.map((c) => String(row[c] ?? "∅")).join("|")
    const raw = row["rowHash"]
    const rowHash = Buffer.isBuffer(raw) ? raw.toString("hex") : String(raw ?? "")
    return { pk, rowHash, pkValues }
  })
}
