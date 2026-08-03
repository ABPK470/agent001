/**
 * Resolve a warehouse pool handle for a Sync environment name.
 */

import type { ConnectionPool } from "mssql"
import { getPool } from "../adapters/mssql/connection.js"
import type { SyncRuntimeHost } from "../ports/host.js"
import type { WarehousePoolHandle } from "../ports/warehouse-pool.js"

export async function resolveWarehousePool(
  host: SyncRuntimeHost,
  connectionName: string,
): Promise<WarehousePoolHandle> {
  const env = host.sync.environments.items.get(connectionName)
  if (!env) {
    const available = Array.from(host.sync.environments.items.keys()).join(", ") || "none"
    throw new Error(`Unknown environment "${connectionName}". Available: ${available}.`)
  }
  const connectorId = typeof env.connectorId === "string" ? env.connectorId.trim() : ""
  if (!connectorId) {
    throw new Error(`Environment "${connectionName}" has no connectorId — cannot resolve warehouse pool.`)
  }

  if (host.sync.warehousePools) {
    return host.sync.warehousePools.get(connectorId)
  }

  // Cutover: MSSQL-only hosts without warehousePools.
  const { pool, entry } = await getPool(host, connectionName)
  return {
    dialect: "mssql",
    connectorId,
    pool: pool as ConnectionPool,
    knowledge: entry.knowledge,
  }
}
