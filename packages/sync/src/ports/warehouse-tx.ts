/**
 * Warehouse transaction — dialect-neutral apply boundary for metadata sync.
 */

import type { WarehouseDialectKind } from "@mia/sql-kit"
import type { WarehouseQueryResult } from "./warehouse-query.js"

export interface WarehouseTx {
  readonly dialect: WarehouseDialectKind
  query<T = Record<string, unknown>>(sqlText: string): Promise<WarehouseQueryResult<T>>
  commit(): Promise<void>
  rollback(): Promise<void>
}
