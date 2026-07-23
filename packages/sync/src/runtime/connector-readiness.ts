/**
 * Live MSSQL connector readiness — resolved at the composition root.
 *
 * Domain eligibility rules consume `readyIds`; this module probes the host.
 */

import type { MssqlAccessHost } from "../ports/host.js"
import type { SyncConnectorReadyIds } from "../core/eligibility/sync-env-eligibility.js"

/** Enabled MSSQL connector ids (live). */
export function readyMssqlConnectorIds(host: MssqlAccessHost): SyncConnectorReadyIds {
  const pools = host.mssql.pools
  if (!pools) return new Set()
  return new Set(pools.list().map((c) => c.id))
}
