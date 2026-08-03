/**
 * Live warehouse connector readiness — resolved at the composition root.
 *
 * Domain eligibility rules consume `readyIds`; this module probes the host.
 * Today the host still exposes MSSQL pools; postgres ids join when a
 * WarehousePoolProvider lists them.
 */

import type { MssqlAccessHost } from "../ports/host.js"
import type { SyncConnectorReadyIds } from "../core/eligibility/sync-env-eligibility.js"

/** Enabled warehouse connector ids currently resolvable via the MSSQL pool provider. */
export function readyMssqlConnectorIds(host: MssqlAccessHost): SyncConnectorReadyIds {
  return readyWarehouseConnectorIds(host)
}

/** Enabled warehouse connector ids (live). Alias for cutover clarity. */
export function readyWarehouseConnectorIds(host: MssqlAccessHost): SyncConnectorReadyIds {
  const pools = host.mssql.pools
  if (!pools) return new Set()
  return new Set(pools.list().map((c) => c.id))
}
