/**
 * Resolve WarehouseDialect from the sync host (default MSSQL for cutover stubs).
 */

import { createMssqlWarehouseDialect } from "../adapters/mssql/dialect/index.js"
import type { SyncRuntimeHost } from "../ports/host.js"
import type { WarehouseDialect } from "../ports/warehouse-dialect.js"

export function resolveWarehouseDialect(host: SyncRuntimeHost): WarehouseDialect {
  return host.sync.warehouseDialect ?? createMssqlWarehouseDialect()
}
