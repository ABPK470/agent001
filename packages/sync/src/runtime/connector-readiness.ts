/**
 * Live warehouse connector readiness — resolved at the composition root.
 *
 * Domain eligibility rules consume `readyIds`; this module probes the host.
 */

import type { MssqlAccessHost, SyncRuntimeHost } from "../ports/host.js"
import type { SyncConnectorReadyIds } from "../core/eligibility/sync-env-eligibility.js"

/** Enabled warehouse connector ids (mssql | postgres when warehousePools is wired). */
export function readyWarehouseConnectorIds(
  host: MssqlAccessHost | SyncRuntimeHost,
): SyncConnectorReadyIds {
  const syncHost = host as SyncRuntimeHost
  const warehouse = syncHost.sync?.warehousePools
  if (warehouse) {
    return new Set(warehouse.list().map((c) => c.id))
  }
  const pools = host.mssql.pools
  if (!pools) return new Set()
  return new Set(pools.list().map((c) => c.id))
}

/** @deprecated Prefer {@link readyWarehouseConnectorIds}. */
export function readyMssqlConnectorIds(host: MssqlAccessHost): SyncConnectorReadyIds {
  return readyWarehouseConnectorIds(host)
}
