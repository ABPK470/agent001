/**
 * Platform MSSQL pool — separate from Sync / Bridge connector pools.
 */

import sql, { type ConnectionPool } from "mssql"
import {
  resolveMssqlPlatformConfig,
  toMssqlDriverConfig,
  type MssqlPlatformConfig,
} from "./config.js"

let cached: ConnectionPool | null = null

export async function openMssqlPlatformPool(
  cfg: MssqlPlatformConfig = resolveMssqlPlatformConfig(),
): Promise<ConnectionPool> {
  if (cached) return cached
  const pool = new sql.ConnectionPool(toMssqlDriverConfig(cfg))
  await pool.connect()
  cached = pool
  return pool
}

export function getMssqlPlatformPoolOrNull(): ConnectionPool | null {
  return cached
}

/** Test / shutdown hook. */
export async function closeMssqlPlatformPool(): Promise<void> {
  if (!cached) return
  const pool = cached
  cached = null
  await pool.close()
}
