/**
 * Kind-aware warehouse pool provider — Sync From/To eligibility + pool resolve.
 *
 * Concrete drivers (mssql ConnectionPool / pg.Pool) stay behind the host
 * composition root; Sync consumes this port for list/dialect and, over time,
 * dialect-aware query/apply.
 */

import type { WarehouseDialectKind } from "@mia/sql-kit"

export type { WarehouseDialectKind }

export type WarehouseConnectorRef = {
  readonly id: string
  readonly name: string
  readonly dialect: WarehouseDialectKind
}

/**
 * Opaque pool handle. Callers branch on `dialect` before using driver fields.
 * Sync apply still uses {@link import("./host.js").MssqlPoolProvider} today;
 * postgres handles feed Bridge and upcoming warehouse query paths.
 */
export type WarehousePoolHandle =
  | {
      readonly dialect: "mssql"
      readonly connectorId: string
      readonly pool: unknown
      readonly knowledge: string | null
    }
  | {
      readonly dialect: "postgres"
      readonly connectorId: string
      readonly pool: unknown
      readonly knowledge: string | null
    }

export interface WarehousePoolProvider {
  get(connectorId: string): Promise<WarehousePoolHandle>
  getByName(name: string): Promise<WarehousePoolHandle>
  list(): Promise<readonly WarehouseConnectorRef[]>
  dialectOf(connectorId: string): Promise<WarehouseDialectKind | undefined>
  invalidate(connectorId: string): void
  /** Close every cached pool (shutdown). */
  closeAll?(): Promise<void>
  runWithSyncBudget?<T>(connectorKey: string, fn: () => Promise<T>): Promise<T>
}
