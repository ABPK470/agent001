/**
 * Live warehouse connector readiness — resolved at the composition root.
 *
 * Domain eligibility rules consume `readyIds`; this module probes the host.
 */

import type { MssqlAccessHost, SyncRuntimeHost } from "../ports/host.js"
import type { SyncConnectorReadyIds } from "../core/eligibility/sync-env-eligibility.js"

/** Enabled warehouse connector ids (mssql | postgres when warehousePools is wired). */
export async function readyWarehouseConnectorIds(
  host: MssqlAccessHost | SyncRuntimeHost,
): Promise<SyncConnectorReadyIds> {
  const syncHost = host as SyncRuntimeHost
  const warehouse = syncHost.sync?.warehousePools
  if (warehouse) {
    return new Set((await warehouse.list()).map((c) => c.id))
  }
  const pools = host.mssql.pools
  if (!pools) return new Set()
  return new Set((await pools.list()).map((c) => c.id))
}

/** @deprecated Prefer {@link readyWarehouseConnectorIds}. */
export async function readyMssqlConnectorIds(host: MssqlAccessHost): Promise<SyncConnectorReadyIds> {
  return readyWarehouseConnectorIds(host)
}
