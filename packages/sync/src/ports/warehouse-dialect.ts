/**
 * WarehouseDialect — Sync warehouse SQL shape behind a pure changeSet core.
 *
 * Implementations live under `adapters/{mssql,postgres}/dialect/**`.
 * Milestone extract: dialect owns SQL strings; runtime still owns pool execute.
 */

import type { WarehouseDialectKind } from "@mia/sql-kit"

export type { WarehouseDialectKind }

/** Capability flags — refuse politely when the dialect cannot honour them. */
export type WarehouseCapability =
  | "mssql_procedure"
  | "identity_insert"
  | "constraint_relax"
  | "temp_tables"

export type WarehouseHashSelectInput = {
  table: string
  pkColumns: readonly string[]
  hashColumns: readonly { name: string; systemType: string }[]
  whereSql: string
}

export type WarehouseUpsertSqlInput = {
  table: string
  pkColumns: readonly string[]
  tempCols: readonly string[]
  updateCols: readonly string[]
  identityCol: string | null
  useIdentityInsert: boolean
  allowUpdate: boolean
  rows: readonly Record<string, unknown>[]
  onInsertStamps: Readonly<Record<string, string>>
  onUpdateStamps: Readonly<Record<string, string>>
}

export type WarehouseDeleteSqlInput = {
  table: string
  pkColumns: readonly string[]
  rows: readonly Record<string, unknown>[]
}

/**
 * Per-dialect warehouse SQL for Sync apply / diff / catalog.
 * Pool acquisition stays on the host; dialect does not own connections.
 */
export interface WarehouseDialect {
  readonly kind: WarehouseDialectKind

  supports(capability: WarehouseCapability): boolean

  quoteIdent(part: string): string
  quoteTable(name: string): string
  quoteLiteral(value: unknown): string

  /** Session / batch prefix (SET options, search_path, …). */
  sessionPrefixSql(): string

  /** SCD2 / audit stamp expression (GETUTCDATE vs NOW() AT TIME ZONE 'utc'). */
  utcNowExpr(): string

  /** Fingerprint SELECT for change detection (HASHBYTES / digest / …). */
  hashSelectSql(input: WarehouseHashSelectInput): string

  /** Target column metadata (`sys.columns` / information_schema). */
  targetColumnsSql(qualifiedTable: string): string

  /** Primary-key column names for a table. */
  primaryKeySql(qualifiedTable: string): string

  /** Temp-table + MERGE upsert batch. */
  upsertBatchSql(input: WarehouseUpsertSqlInput): string

  /** Temp-table + DELETE batch. */
  deleteBatchSql(input: WarehouseDeleteSqlInput): string
}
