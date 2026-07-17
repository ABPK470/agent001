/**
 * runtime/mssql-pool-provider.ts — live, connector-keyed MSSQL pool provider.
 *
 * Single source of truth for MSSQL database connections: connectors
 * persisted in SQLite, read live on every call. Sync environments resolve
 * their pool through `connectorId` (the real FK); the agent's direct MSSQL
 * tools/catalog resolve through `getByName`. Pools are built lazily from the
 * connector config and cached by connector id; a config fingerprint makes the
 * cache self-correcting if a connector is edited without an explicit
 * `invalidate`. No boot-time name map, no name-matching fallback.
 */

import type { MssqlConnectorPool, MssqlPoolProvider } from "@mia/agent"
import type { Connector, ConnectorKindId } from "@mia/shared-types"
import sql from "mssql"
import * as db from "../../../platform/persistence/sqlite.js"
import { readKnowledgeFile } from "../../../platform/mssql/setup.js"

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

/** Parse a persisted row's body_json back into a Connector. */
function parseConnector(row: db.DbConnector): Connector {
  const body = JSON.parse(row.body_json) as Connector
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

/** Read every persisted connector live from the DB. */
function listConnectorsLive(): readonly Connector[] {
  return db.listConnectors().map(parseConnector)
}

/** Find a single connector by id, live. */
function getConnectorLive(id: string): Connector | undefined {
  const row = db.getConnector(id)
  return row ? parseConnector(row) : undefined
}

/** Enabled mssql connectors, live. */
function listEnabledMssql(): readonly Connector[] {
  return listConnectorsLive().filter((c) => c.kind === "mssql" && c.enabled)
}

/** A stable fingerprint of the connection-relevant config fields. */
function configFingerprint(connector: Connector): string {
  const c = connector.config
  return JSON.stringify({
    host: asString(c["host"]),
    port: asNumber(c["port"]),
    database: asString(c["database"]),
    user: asString(c["user"]),
    password: asString(c["password"]),
    domain: asString(c["domain"]),
    encrypt: asBoolean(c["encrypt"], true),
    trustServerCertificate: asBoolean(c["trustServerCertificate"], true),
    writeEnabled: asBoolean(c["writeEnabled"], false),
    knowledgePath: asString(c["knowledgePath"]),
  })
}

/** Build a finalized `sql.config` (mirrors the agent's setMssqlConfig defaults). */
function buildConfig(connector: Connector, projectRoot: string): {
  config: sql.config
  writeEnabled: boolean
  knowledge: string | null
} {
  const c = connector.config
  const host = asString(c["host"])
  const knowledgePath = asString(c["knowledgePath"])
  const rest: sql.config = {
    server: host ?? "",
    port: asNumber(c["port"]) ?? 1433,
    database: asString(c["database"]) ?? "master",
    user: asString(c["user"]) ?? "sa",
    password: asString(c["password"]) ?? "",
    ...(asString(c["domain"]) ? { domain: asString(c["domain"])! } : {}),
    options: {
      encrypt: asBoolean(c["encrypt"], true),
      trustServerCertificate: asBoolean(c["trustServerCertificate"], true),
    },
  }
  const config: sql.config = {
    ...rest,
    options: {
      encrypt: true,
      trustServerCertificate: true,
      ...rest.options,
    },
    pool: {
      min: 0,
      max: 20,
      idleTimeoutMillis: 30_000,
      ...(rest.pool ?? {}),
    },
    requestTimeout: rest.requestTimeout ?? 120_000,
    connectionTimeout: rest.connectionTimeout ?? 15_000,
  }
  return {
    config,
    writeEnabled: asBoolean(c["writeEnabled"], false),
    knowledge: knowledgePath ? readKnowledgeFile(projectRoot, knowledgePath) : null,
  }
}

interface CachedEntry {
  connectorId: string
  fingerprint: string
  pool: sql.ConnectionPool | null
  config: sql.config
  writeEnabled: boolean
  knowledge: string | null
}

/**
 * Build a live MSSQL pool provider backed by the connectors SQLite table.
 */
export function createMssqlPoolProvider(projectRoot: string): MssqlPoolProvider {
  const cache = new Map<string, CachedEntry>()

  async function resolve(connector: Connector): Promise<MssqlConnectorPool> {
    const fp = configFingerprint(connector)
    let entry = cache.get(connector.id)
    if (!entry || entry.fingerprint !== fp) {
      if (entry?.pool) {
        try {
          await entry.pool.close()
        } catch {
          /* ignore */
        }
      }
      const built = buildConfig(connector, projectRoot)
      entry = {
        connectorId: connector.id,
        fingerprint: fp,
        pool: null,
        config: built.config,
        writeEnabled: built.writeEnabled,
        knowledge: built.knowledge,
      }
      cache.set(connector.id, entry)
    }
    if (!entry.pool) {
      const pool = new sql.ConnectionPool(entry.config)
      // Absorb late/async pool errors so they never crash the process.
      pool.on("error", (err) => {
        console.warn(
          `[mssql] pool "${connector.name}" (${connector.id}) error:`,
          err instanceof Error ? err.message : err,
        )
      })
      await pool.connect()
      entry.pool = pool
    } else if (!entry.pool.connected) {
      try {
        await entry.pool.close()
      } catch {
        /* ignore */
      }
      entry.pool = new sql.ConnectionPool(entry.config)
      entry.pool.on("error", (err) => {
        console.warn(
          `[mssql] pool "${connector.name}" (${connector.id}) error:`,
          err instanceof Error ? err.message : err,
        )
      })
      await entry.pool.connect()
    }
    return {
      connectorId: entry.connectorId,
      pool: entry.pool,
      config: entry.config,
      writeEnabled: entry.writeEnabled,
      knowledge: entry.knowledge,
    }
  }

  return {
    async get(connectorId: string): Promise<MssqlConnectorPool> {
      const connector = getConnectorLive(connectorId)
      if (!connector || connector.kind !== "mssql" || !connector.enabled) {
        const available = listEnabledMssql()
          .map((c) => c.id)
          .join(", ")
        throw new Error(
          `MSSQL connector "${connectorId}" not configured. Available: ${available || "none"}.`,
        )
      }
      return resolve(connector)
    },
    async getByName(name: string): Promise<MssqlConnectorPool> {
      const list = listEnabledMssql()
      const lower = name.toLowerCase()
      const connector =
        list.find((c) => c.name.toLowerCase() === lower) ??
        (name === "default" && list.length > 0 ? list[0] : undefined)
      if (!connector) {
        const available = list.map((c) => c.name).join(", ")
        throw new Error(
          `MSSQL connection "${name}" not configured. Available: ${available || "none"}.`,
        )
      }
      return resolve(connector)
    },
    list(): readonly { id: string; name: string }[] {
      return listEnabledMssql().map((c) => ({ id: c.id, name: c.name }))
    },
    configOf(connectorId: string): sql.config | undefined {
      const connector = getConnectorLive(connectorId)
      if (!connector || connector.kind !== "mssql" || !connector.enabled) return undefined
      return buildConfig(connector, projectRoot).config
    },
    invalidate(connectorId: string): void {
      const entry = cache.get(connectorId)
      if (entry?.pool) {
        try {
          void entry.pool.close()
        } catch {
          /* ignore */
        }
      }
      cache.delete(connectorId)
    },
  }
}
