/**
 * Live, connector-keyed PostgreSQL pool provider.
 *
 * Mirrors {@link createMssqlPoolProvider}: connectors from SQLite, lazy pools
 * cached by connector id, fingerprint invalidation on config change.
 */

import { parseBoundaryJson } from "../../internal/parse-json.js"
import type { Connector, ConnectorKindId } from "@mia/shared-types"
import { Pool, type PoolConfig } from "pg"
import * as db from "../../infra/persistence/sqlite.js"
import {
  getConnectionBudget,
  syncBudgetLimit,
} from "../../ports/connection-budget.js"

export type PostgresConnectorPool = {
  connectorId: string
  pool: Pool
  config: PoolConfig
  knowledge: string | null
}

export interface PostgresPoolProvider {
  get(connectorId: string): Promise<PostgresConnectorPool>
  getByName(name: string): Promise<PostgresConnectorPool>
  list(): readonly { id: string; name: string }[]
  invalidate(connectorId: string): void
  closeAll(): Promise<void>
  runWithSyncBudget?<T>(connectorKey: string, fn: () => Promise<T>): Promise<T>
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function parseConnector(row: db.DbConnector): Connector {
  const body = parseBoundaryJson(row.body_json) as Connector
  return {
    ...body,
    id: row.id,
    kind: row.kind as ConnectorKindId,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

function listConnectorsLive(): readonly Connector[] {
  return db.listConnectors().map(parseConnector)
}

function getConnectorLive(id: string): Connector | undefined {
  const row = db.getConnector(id)
  return row ? parseConnector(row) : undefined
}

function listEnabledPostgres(): readonly Connector[] {
  return listConnectorsLive().filter((c) => c.kind === "postgres" && c.enabled)
}

function configFingerprint(connector: Connector): string {
  const c = connector.config
  return JSON.stringify({
    host: asString(c["host"]),
    port: asNumber(c["port"]),
    database: asString(c["database"]),
    user: asString(c["user"]),
    password: asString(c["password"]),
    ssl: asBoolean(c["ssl"], false),
    knowledgePath: asString(c["knowledgePath"]),
  })
}

function buildConfig(connector: Connector): PoolConfig {
  const c = connector.config
  return {
    host: asString(c["host"]) ?? "localhost",
    port: asNumber(c["port"]) ?? 5432,
    database: asString(c["database"]) ?? "postgres",
    user: asString(c["user"]) ?? "postgres",
    password: asString(c["password"]) ?? "",
    ssl: asBoolean(c["ssl"], false) ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30_000,
  }
}

interface CachedEntry {
  connectorId: string
  fingerprint: string
  pool: Pool | null
  config: PoolConfig
  knowledge: string | null
}

export function createPostgresPoolProvider(): PostgresPoolProvider {
  const cache = new Map<string, CachedEntry>()

  async function resolve(connector: Connector): Promise<PostgresConnectorPool> {
    const fp = configFingerprint(connector)
    let entry = cache.get(connector.id)
    if (!entry || entry.fingerprint !== fp) {
      if (entry?.pool) {
        try {
          await entry.pool.end()
        } catch (err: unknown) {
          console.error("[mia]", err)
        }
      }
      entry = {
        connectorId: connector.id,
        fingerprint: fp,
        pool: null,
        config: buildConfig(connector),
        knowledge: null,
      }
      cache.set(connector.id, entry)
    }
    if (!entry.pool) {
      const pool = new Pool(entry.config)
      pool.on("error", (err) => {
        console.warn(
          `[postgres] pool "${connector.name}" (${connector.id}) error:`,
          err instanceof Error ? err.message : err,
        )
      })
      entry.pool = pool
    }
    return {
      connectorId: entry.connectorId,
      pool: entry.pool,
      config: entry.config,
      knowledge: entry.knowledge,
    }
  }

  return {
    async get(connectorId: string): Promise<PostgresConnectorPool> {
      const connector = getConnectorLive(connectorId)
      if (!connector || connector.kind !== "postgres" || !connector.enabled) {
        const available = listEnabledPostgres()
          .map((c) => c.id)
          .join(", ")
        throw new Error(
          `Postgres connector "${connectorId}" not configured. Available: ${available || "none"}.`,
        )
      }
      return resolve(connector)
    },

    async getByName(name: string): Promise<PostgresConnectorPool> {
      const list = listEnabledPostgres()
      const lower = name.toLowerCase()
      const connector =
        list.find((c) => c.name.toLowerCase() === lower) ??
        (name === "default" && list.length > 0 ? list[0] : undefined)
      if (!connector) {
        const available = list.map((c) => c.name).join(", ")
        throw new Error(
          `Postgres connection "${name}" not configured. Available: ${available || "none"}.`,
        )
      }
      return resolve(connector)
    },

    list(): readonly { id: string; name: string }[] {
      return listEnabledPostgres().map((c) => ({ id: c.id, name: c.name }))
    },

    invalidate(connectorId: string): void {
      const entry = cache.get(connectorId)
      if (entry?.pool) {
        void entry.pool.end().catch((err: unknown) => {
          console.error("[mia]", err)
        })
      }
      cache.delete(connectorId)
    },

    async closeAll(): Promise<void> {
      const ending = [...cache.values()].map(async (entry) => {
        if (!entry.pool) return
        try {
          await entry.pool.end()
        } catch (err: unknown) {
          console.error("[mia]", err)
        }
      })
      cache.clear()
      await Promise.all(ending)
    },

    async runWithSyncBudget<T>(connectorKey: string, fn: () => Promise<T>): Promise<T> {
      const limit = syncBudgetLimit(20)
      return getConnectionBudget().withSlot(connectorKey, "sync-work", limit, fn)
    },
  }
}
