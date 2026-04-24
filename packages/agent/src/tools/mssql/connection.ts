import sql from "mssql"
import { AsyncLocalStorage } from "node:async_hooks"

// ── Named connection registry ────────────────────────────────────

export interface DatabaseEntry {
  config: sql.config
  pool: sql.ConnectionPool | null
  writeEnabled: boolean
  knowledge: string | null
}

const _databases = new Map<string, DatabaseEntry>()

/**
 * Per-tool-call kill signal — when aborted, cancels any in-flight query.
 *
 * Two storage layers (concurrency-safe):
 *   1. AsyncLocalStorage scoped per tool execution (preferred). The
 *      orchestrator wraps each tool call in `runWithMssqlKillSignal()` so
 *      concurrent runs see their own signal even when interleaved.
 *   2. A module-level fallback for callers that don't enter the ALS scope
 *      (single-user CLI mode, legacy tests). Setting null clears it.
 *
 * The fallback was the *only* path before multi-user — it's a real
 * concurrency bug under multi-user load (last writer wins). ALS fixes it.
 */
const killSignalAls = new AsyncLocalStorage<AbortSignal>()
let _fallbackKillSignal: AbortSignal | null = null

/** Set the fallback (non-ALS) kill signal. Prefer runWithMssqlKillSignal. */
export function setMssqlKillSignal(signal: AbortSignal | null): void {
  _fallbackKillSignal = signal
}

/** Get the active kill signal (ALS-scoped > fallback). */
export function getMssqlKillSignal(): AbortSignal | null {
  return killSignalAls.getStore() ?? _fallbackKillSignal
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
  _databases.set(name, {
    config: {
      ...config,
      options: {
        encrypt: true,
        trustServerCertificate: true,
        ...config.options,
      },
      requestTimeout: config.requestTimeout ?? 60_000,
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
  _databases.clear()
  for (const { name, writeEnabled = false, knowledge = null, ...rest } of configs) {
    _databases.set(name, {
      config: {
        ...rest,
        options: {
          encrypt: true,
          trustServerCertificate: true,
          ...(rest as sql.config).options,
        },
        requestTimeout: (rest as sql.config).requestTimeout ?? 60_000,
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
  const entry = _databases.get(name)
  if (entry) entry.writeEnabled = enabled
}

/** Return a safe summary of all configured connections (no credentials). */
export function getMssqlConfig(): Array<{ name: string; server: string; database: string; writeEnabled: boolean; knowledge: string | null }> {
  return Array.from(_databases.entries()).map(([name, entry]) => ({
    name,
    server: entry.config.server!,
    database: entry.config.database!,
    writeEnabled: entry.writeEnabled,
    knowledge: entry.knowledge,
  }))
}

/** Get or create the connection pool for a named connection. */
export async function getPool(name = "default"): Promise<{ pool: sql.ConnectionPool; entry: DatabaseEntry }> {
  const entry = _databases.get(name)
  if (!entry) {
    const available = Array.from(_databases.keys()).join(", ") || "none"
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
  for (const entry of _databases.values()) {
    if (entry.pool) {
      try { await entry.pool.close() } catch { /* ignore */ }
      entry.pool = null
    }
  }
}
