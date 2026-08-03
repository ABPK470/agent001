/**
 * Pool provider *shape* — not a global pool.
 * Platform store and warehouse Sync each wire their own providers.
 */

/** Relational targets Mia supports for platform store and warehouse Sync. */
export type RelationalDialectKind = "sqlite" | "mssql" | "postgres"

/** Warehouse Sync From/To eligibility (platform sqlite is never a warehouse target). */
export type WarehouseDialectKind = "mssql" | "postgres"

/**
 * Minimal long-lived pool handle. Concrete drivers (mssql / pg) attach behind
 * host adapters; Sync only sees this shape through {@link WarehousePoolProvider}.
 */
export interface SqlPoolHandle {
  readonly dialect: WarehouseDialectKind
  readonly connectorId: string
}

/**
 * Kind-aware warehouse pool resolution (replaces MSSQL-only providers over time).
 * Host composition roots implement this; Sync runtime consumes it.
 */
export interface WarehousePoolProvider {
  get(connectorId: string): Promise<SqlPoolHandle>
  getByName(name: string): Promise<SqlPoolHandle>
  list(): readonly { id: string; name: string; dialect: WarehouseDialectKind }[]
  invalidate(connectorId: string): void
  /** Optional shared budget for sync-work leases (wired by the platform shell). */
  runWithSyncBudget?<T>(connectorKey: string, fn: () => Promise<T>): Promise<T>
}
