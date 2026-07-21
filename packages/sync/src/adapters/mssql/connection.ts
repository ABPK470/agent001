import sql from "mssql"
import type { MssqlAccessHost, MssqlEntry, SyncEnvironmentRegistryHost } from "../../ports/host.js"
import { getEnvironment } from "../../domain/environments.js"

export type { MssqlEntry }

export function getMssqlConfig(host: MssqlAccessHost): Array<{
  name: string
  server: string
  database: string
  knowledge: string | null
}> {
  return Array.from(host.mssql.databases.entries()).map(([name, entry]) => ({
    name,
    server: entry.config.server!,
    database: entry.config.database!,
    knowledge: entry.knowledge
  }))
}

/**
 * Resolve an MSSQL pool for a sync environment name.
 *
 * The environment's `connectorId` is the real foreign key to a persisted MSSQL
 * connector; the pool is built/cached live by `host.mssql.pools`. There is no
 * boot-time name-keyed map and no name-matching fallback: a missing provider,
 * a missing `connectorId`, or an unknown environment all fail loudly.
 */
export async function getPool(
  host: MssqlAccessHost & SyncEnvironmentRegistryHost,
  name = "default"
): Promise<{ pool: sql.ConnectionPool; entry: MssqlEntry }> {
  const pools = host.mssql.pools
  if (!pools) {
    throw new Error("MSSQL pool provider not configured — pass mssqlPools to configureAgent().")
  }
  const env = getEnvironment(host, name)
  if (!env.connectorId) {
    throw new Error(`Environment "${name}" has no connectorId — cannot resolve MSSQL pool.`)
  }
  const resolved = await pools.get(env.connectorId)
  return {
    pool: resolved.pool,
    entry: {
      config: resolved.config,
      pool: resolved.pool,
      knowledge: resolved.knowledge
    }
  }
}
