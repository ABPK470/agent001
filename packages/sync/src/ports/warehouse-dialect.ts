/**
 * WarehouseDialect — Sync warehouse SQL shape behind a pure changeSet core.
 *
 * Implementations live under `adapters/{mssql,postgres}/dialect/**`.
 * Zero dialect SQL in domain/ports; runtime extract is the next milestone.
 */

import type { WarehouseDialectKind } from "@mia/sql-kit"

export type { WarehouseDialectKind }

/** Capability flags — refuse politely when the dialect cannot honour them. */
export type WarehouseCapability =
  | "mssql_procedure"
  | "identity_insert"
  | "constraint_relax"
  | "temp_tables"

export type WarehouseColumnMeta = {
  name: string
  systemType: string
  isNullable: boolean
  isIdentity?: boolean
}

export type WarehouseTableCatalog = {
  schema: string
  table: string
  columns: readonly WarehouseColumnMeta[]
  primaryKey: readonly string[]
  hasTriggers?: boolean
}

export type WarehouseHashSelectInput = {
  table: string
  pkColumns: readonly string[]
  hashColumns: readonly { name: string; systemType: string }[]
  whereSql?: string
}

export type WarehouseUpsertBatchInput = {
  table: string
  pkColumns: readonly string[]
  columns: readonly string[]
  rows: readonly Record<string, unknown>[]
}

export type WarehouseDeleteBatchInput = {
  table: string
  pkColumns: readonly string[]
  rows: readonly Record<string, unknown>[]
}

/**
 * Per-dialect warehouse operations for Sync apply / diff / catalog.
 * Pool acquisition stays on the host ({@link import("./host.js").MssqlPoolProvider}
 * today; kind-aware {@link import("@mia/sql-kit").WarehousePoolProvider} next).
 */
export interface WarehouseDialect {
  readonly kind: WarehouseDialectKind

  supports(capability: WarehouseCapability): boolean

  quoteIdent(part: string): string
  quoteTable(name: string): string
  quoteLiteral(value: unknown): string

  /** Session / batch prefix (SET options, search_path, …). */
  sessionPrefixSql(): string

  loadTableCatalog(table: string): Promise<WarehouseTableCatalog>

  /** Fingerprint SELECT for change detection (HASHBYTES / digest / …). */
  hashSelectSql(input: WarehouseHashSelectInput): string

  upsertBatch(input: WarehouseUpsertBatchInput): Promise<{ affected: number }>
  deleteBatch(input: WarehouseDeleteBatchInput): Promise<{ affected: number }>

  /** SCD2 / audit stamp expression (e.g. GETUTCDATE vs NOW() AT TIME ZONE 'utc'). */
  utcNowExpr(): string
}
