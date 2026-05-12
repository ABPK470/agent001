import sql from "mssql"
import { AsyncLocalStorage } from "node:async_hooks"
import { currentRuntime } from "../../agent-runtime.js"

// ── Named connection registry ────────────────────────────────────

export interface DatabaseEntry {
  config: sql.config
  pool: sql.ConnectionPool | null
  writeEnabled: boolean
  knowledge: string | null
}

// State container — `const` reference to a mutable record so the lint rule
// banning module-level `let` passes while preserving the existing singleton
// shape. Owned by AgentRuntime in future, but the API surface stays.

// `currentRuntime().mssql.databases` is the connection registry (set up by
// the server via `setMssqlConfig*`). Lives on the active AgentRuntime.

/** Override which named connection is used when connection='default' or is omitted. */
export function setDefaultMssqlConnection(name: string): void {
  currentRuntime().mssql.defaultConnection = name
}

/** Return the configured default connection name (null = fall back to first). */
export function getDefaultMssqlConnectionName(): string | null {
  return currentRuntime().mssql.defaultConnection
}

/**
 * Per-tool-call kill signal — when aborted, cancels any in-flight query.
 *
 * Stored in `AsyncLocalStorage` scoped per tool execution. The orchestrator
 * wraps each tool call in `runWithMssqlKillSignal()` so concurrent runs see
 * their own signal even when interleaved. There is no module-level fallback:
 * the legacy `setMssqlKillSignal` was a known concurrency bug (last writer
 * wins under multi-user load) and was deleted in Phase 2.
 */
const killSignalAls = new AsyncLocalStorage<AbortSignal>()

/** Get the active kill signal (ALS-scoped). */
export function getMssqlKillSignal(): AbortSignal | null {
  return killSignalAls.getStore() ?? null
}

/** Run `fn` with `signal` as the active mssql kill signal for its async context. */
export function runWithMssqlKillSignal<T>(signal: AbortSignal, fn: () => T): T {
  return killSignalAls.run(signal, fn)
}

/**
 * Configure a single MSSQL connection.
 * @param config  mssql connection config
 * @param name    Connection name used in the `connection` tool parameter.
 *                Defaults to "default" for backwards compatibility.
 */
export function setMssqlConfig(config: sql.config, name = "default", knowledge: string | null = null): void {
  currentRuntime().mssql.databases.set(name, {
    config: {
      ...config,
      options: {
        encrypt: true,
        trustServerCertificate: true,
        ...config.options,
      },
      pool: {
        min: 0,
        max: 20,
        idleTimeoutMillis: 30_000,
        ...(config.pool ?? {}),
      },
      requestTimeout: config.requestTimeout ?? 120_000,
      connectionTimeout: config.connectionTimeout ?? 15_000,
    },
    pool: null,
    writeEnabled: false,
    knowledge,
  })
}

/**
 * Configure multiple named MSSQL connections at once (replaces all existing).
 * Each entry must include a `name` field. The first entry is also the "default".
 */
export function setMssqlConfigs(
  configs: Array<{ name: string; writeEnabled?: boolean; knowledge?: string | null } & sql.config>,
): void {
  currentRuntime().mssql.databases.clear()
  for (const { name, writeEnabled = false, knowledge = null, ...rest } of configs) {
    currentRuntime().mssql.databases.set(name, {
      config: {
        ...rest,
        options: {
          encrypt: true,
          trustServerCertificate: true,
          ...(rest as sql.config).options,
        },
        pool: {
          min: 0,
          max: 20,
          idleTimeoutMillis: 30_000,
          ...((rest as sql.config).pool ?? {}),
        },
        requestTimeout: (rest as sql.config).requestTimeout ?? 120_000,
        connectionTimeout: (rest as sql.config).connectionTimeout ?? 15_000,
      },
      pool: null,
      writeEnabled,
      knowledge,
    })
  }
}

/** Enable/disable write operations for a named connection (default: "default"). */
export function setMssqlWriteEnabled(enabled: boolean, name = "default"): void {
  const entry = currentRuntime().mssql.databases.get(name)
  if (entry) entry.writeEnabled = enabled
}

/** Return a safe summary of all configured connections (no credentials). */
export function getMssqlConfig(): Array<{ name: string; server: string; database: string; writeEnabled: boolean; knowledge: string | null }> {
  return Array.from(currentRuntime().mssql.databases.entries()).map(([name, entry]) => ({
    name,
    server: entry.config.server!,
    database: entry.config.database!,
    writeEnabled: entry.writeEnabled,
    knowledge: entry.knowledge,
  }))
}

/** Get or create the connection pool for a named connection. */
export async function getPool(name = "default"): Promise<{ pool: sql.ConnectionPool; entry: DatabaseEntry }> {
  // In multi-database mode the connections are named (e.g. "uat", "dev") and
  // there is no "default" entry.  Fall back to:
  //   1. The connection named by setDefaultMssqlConnection() / MSSQL_DEFAULT_CONNECTION
  //   2. The first configured connection (legacy fallback)
  const mssql = currentRuntime().mssql
  const resolvedName = mssql.databases.has(name)
    ? name
    : (name === "default" && mssql.databases.size > 0)
      ? (mssql.defaultConnection && mssql.databases.has(mssql.defaultConnection)
          ? mssql.defaultConnection
          : mssql.databases.keys().next().value as string)
      : name
  const entry = mssql.databases.get(resolvedName)
  if (!entry) {
    const available = Array.from(mssql.databases.keys()).join(", ") || "none"
    throw new Error(
      `MSSQL connection "${name}" not configured. Available: ${available}. ` +
      `Call setMssqlConfig() or setMssqlConfigs() at startup.`,
    )
  }
  if (entry.pool?.connected) return { pool: entry.pool, entry }
  if (entry.pool) {
    try { await entry.pool.close() } catch { /* ignore */ }
  }
  entry.pool = new sql.ConnectionPool(entry.config)
  await entry.pool.connect()
  return { pool: entry.pool, entry }
}

/** Close all connection pools (called on shutdown). */
export async function closeMssqlPool(): Promise<void> {
  for (const entry of currentRuntime().mssql.databases.values()) {
    if (entry.pool) {
      try { await entry.pool.close() } catch { /* ignore */ }
      entry.pool = null
    }
  }
}
