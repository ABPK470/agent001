import sql from "mssql"
import type { AgentHost } from "../../../runtime/runtime.js"
import {
  canonicalizeConfiguredConnectionName,
  listMssqlConnectionNames,
  resolveMssqlConnectionName,
  tryResolveMssqlConnectionName
} from "./resolve-connection.js"

// ── Named connection registry ────────────────────────────────────

export interface DatabaseEntry {
  config: sql.config
  pool: sql.ConnectionPool | null
  knowledge: string | null
}

// The connection registry lives on `host.mssql.databases` (a real Map
// shared across every per-run host built at boot via `bootHostDeps`).
// All setters/getters in this module take the host explicitly — there
// is no module-level state and no ALS lookup.

/** Override which named connection is used when connection='default' or is omitted. */
export function setDefaultMssqlConnection(host: AgentHost, name: string): void {
  const canonical = canonicalizeConfiguredConnectionName(listMssqlConnectionNames(host), name)
  host.mssql.defaultConnection.value = canonical ?? name
}

/** Return the configured default connection name (canonical registry key). */
export function getDefaultMssqlConnectionName(host: AgentHost): string | null {
  const raw = host.mssql.defaultConnection.value
  if (!raw) return null
  return canonicalizeConfiguredConnectionName(listMssqlConnectionNames(host), raw) ?? raw
}

/**
 * Configure a single MSSQL connection.
 * @param host    Host whose mssql registry is being populated.
 * @param config  mssql connection config
 * @param name    Connection name used in the `connection` tool parameter.
 *                Defaults to "default" for backwards compatibility.
 */
export function setMssqlConfig(
  host: AgentHost,
  config: sql.config,
  name = "default",
  knowledge: string | null = null
): void {
  host.mssql.databases.set(name, {
    config: {
      ...config,
      options: {
        encrypt: true,
        trustServerCertificate: true,
        ...config.options
      },
      pool: {
        min: 0,
        max: 20,
        idleTimeoutMillis: 30_000,
        ...(config.pool ?? {})
      },
      requestTimeout: config.requestTimeout ?? 120_000,
      connectionTimeout: config.connectionTimeout ?? 15_000
    },
    pool: null,
    knowledge
  })
}

/**
 * Configure multiple named MSSQL connections at once (replaces all existing).
 * Each entry must include a `name` field. The first entry is also the "default".
 */
export function setMssqlConfigs(
  host: AgentHost,
  configs: Array<{ name: string; knowledge?: string | null } & sql.config>
): void {
  host.mssql.databases.clear()
  for (const { name, knowledge = null, ...rest } of configs) {
    host.mssql.databases.set(name, {
      config: {
        ...rest,
        options: {
          encrypt: true,
          trustServerCertificate: true,
          ...(rest as sql.config).options
        },
        pool: {
          min: 0,
          max: 20,
          idleTimeoutMillis: 30_000,
          ...((rest as sql.config).pool ?? {})
        },
        requestTimeout: (rest as sql.config).requestTimeout ?? 120_000,
        connectionTimeout: (rest as sql.config).connectionTimeout ?? 15_000
      },
      pool: null,
      knowledge
    })
  }
}

/** Return a safe summary of all configured connections (no credentials). */
export function getMssqlConfig(host: AgentHost): Array<{
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

/** Get or create the connection pool for a named connection. */
export async function getPool(
  host: AgentHost,
  name = "default"
): Promise<{ pool: sql.ConnectionPool; entry: DatabaseEntry }> {
  const resolvedName = resolveMssqlConnectionName(host, name)
  const pools = host.mssql.pools
  if (pools) {
    // Live provider path (production): resolvedName is a connector id.
    const r = await pools.get(resolvedName)
    return {
      pool: r.pool,
      entry: { config: r.config, pool: r.pool, knowledge: r.knowledge }
    }
  }
  // Legacy databases-map path (tests/hosts without a live provider).
  const entry = host.mssql.databases.get(resolvedName)
  if (!entry) {
    const available = listMssqlConnectionNames(host).join(", ") || "none"
    throw new Error(
      `MSSQL connection "${name}" not configured. Available: ${available}. ` +
        `Call setMssqlConfig() or setMssqlConfigs() at startup.`
    )
  }
  if (entry.pool?.connected) return { pool: entry.pool, entry }
  if (entry.pool) {
    try {
      await entry.pool.close()
    } catch (err: unknown) { console.error("[mia]", err) }
  }
  entry.pool = new sql.ConnectionPool(entry.config)
  // Absorb late/async pool errors (e.g. tedious emitting `socketError` after
  // the connection has entered `Final`). Without a listener these would be
  // rethrown by EventEmitter and crash the process.
  entry.pool.on("error", (err) => {
    console.warn(`[mssql] pool "${resolvedName}" error:`, err instanceof Error ? err.message : err)
  })
  await entry.pool.connect()
  return { pool: entry.pool, entry }
}

/** Close all connection pools (called on shutdown). */
export async function closeMssqlPool(host: AgentHost): Promise<void> {
  for (const entry of host.mssql.databases.values()) {
    if (entry.pool) {
      try {
        await entry.pool.close()
      } catch (err: unknown) { console.error("[mia]", err) }
      entry.pool = null
    }
  }
}
