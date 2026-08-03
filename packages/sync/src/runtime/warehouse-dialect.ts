/**
 * Resolve WarehouseDialect from the sync host (per-env when warehouse pools exist).
 */

import { createMssqlWarehouseDialect } from "../adapters/mssql/dialect/index.js"
import { createPostgresWarehouseDialect } from "../adapters/postgres/dialect/index.js"
import type { SyncRuntimeHost } from "../ports/host.js"
import type { WarehouseDialect } from "../ports/warehouse-dialect.js"

export function resolveWarehouseDialect(
  host: SyncRuntimeHost,
  connectionName?: string,
): WarehouseDialect {
  if (connectionName) {
    const env = host.sync.environments.items.get(connectionName)
    const connectorId = typeof env?.connectorId === "string" ? env.connectorId.trim() : ""
    const kind = connectorId ? host.sync.warehousePools?.dialectOf(connectorId) : undefined
    if (kind === "postgres") return createPostgresWarehouseDialect()
    if (kind === "mssql") return createMssqlWarehouseDialect()
  }
  return host.sync.warehouseDialect ?? createMssqlWarehouseDialect()
}
