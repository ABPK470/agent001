/**
 * Kind-aware warehouse pool facade — mssql | postgres connectors for Sync.
 */

import type { MssqlPoolProvider } from "@mia/agent"
import type {
  WarehouseConnectorRef,
  WarehousePoolHandle,
  WarehousePoolProvider,
} from "@mia/sync"
import type { WarehouseDialectKind } from "@mia/sql-kit"
import type { PostgresPoolProvider } from "./postgres-pool-provider.js"

export function createWarehousePoolProvider(input: {
  mssql: MssqlPoolProvider
  postgres: PostgresPoolProvider
}): WarehousePoolProvider {
  const { mssql, postgres } = input

  function dialectOf(connectorId: string): WarehouseDialectKind | undefined {
    if (mssql.list().some((c) => c.id === connectorId)) return "mssql"
    if (postgres.list().some((c) => c.id === connectorId)) return "postgres"
    return undefined
  }

  function list(): readonly WarehouseConnectorRef[] {
    return [
      ...mssql.list().map((c) => ({ id: c.id, name: c.name, dialect: "mssql" as const })),
      ...postgres.list().map((c) => ({
        id: c.id,
        name: c.name,
        dialect: "postgres" as const,
      })),
    ]
  }

  async function get(connectorId: string): Promise<WarehousePoolHandle> {
    const kind = dialectOf(connectorId)
    if (kind === "mssql") {
      const resolved = await mssql.get(connectorId)
      return {
        dialect: "mssql",
        connectorId: resolved.connectorId,
        pool: resolved.pool,
        knowledge: resolved.knowledge,
      }
    }
    if (kind === "postgres") {
      const resolved = await postgres.get(connectorId)
      return {
        dialect: "postgres",
        connectorId: resolved.connectorId,
        pool: resolved.pool,
        knowledge: resolved.knowledge,
      }
    }
    const available = list()
      .map((c) => c.id)
      .join(", ")
    throw new Error(
      `Warehouse connector "${connectorId}" not configured. Available: ${available || "none"}.`,
    )
  }

  async function getByName(name: string): Promise<WarehousePoolHandle> {
    const lower = name.toLowerCase()
    const mssqlHit = mssql.list().find((c) => c.name.toLowerCase() === lower)
    if (mssqlHit) return get(mssqlHit.id)
    const pgHit = postgres.list().find((c) => c.name.toLowerCase() === lower)
    if (pgHit) return get(pgHit.id)
    if (name === "default") {
      const first = list()[0]
      if (first) return get(first.id)
    }
    const available = list()
      .map((c) => c.name)
      .join(", ")
    throw new Error(
      `Warehouse connection "${name}" not configured. Available: ${available || "none"}.`,
    )
  }

  function invalidate(connectorId: string): void {
    mssql.invalidate(connectorId)
    postgres.invalidate(connectorId)
  }

  async function closeAll(): Promise<void> {
    await postgres.closeAll()
  }

  async function runWithSyncBudget<T>(connectorKey: string, fn: () => Promise<T>): Promise<T> {
    const kind = dialectOf(connectorKey)
    if (kind === "postgres" && postgres.runWithSyncBudget) {
      return postgres.runWithSyncBudget(connectorKey, fn)
    }
    if (mssql.runWithSyncBudget) {
      return mssql.runWithSyncBudget(connectorKey, fn)
    }
    return fn()
  }

  return {
    get,
    getByName,
    list,
    dialectOf,
    invalidate,
    closeAll,
    runWithSyncBudget,
  }
}
