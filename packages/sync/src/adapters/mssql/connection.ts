import sql from "mssql"
import type { AgentHost, MssqlEntry } from "../../ports/host.js"

export type { MssqlEntry }

export function getMssqlConfig(host: AgentHost): Array<{ name: string; server: string; database: string; writeEnabled: boolean; knowledge: string | null }> {
  return Array.from(host.mssql.databases.entries()).map(([name, entry]) => ({
    name,
    server: entry.config.server!,
    database: entry.config.database!,
    writeEnabled: entry.writeEnabled,
    knowledge: entry.knowledge,
  }))
}

export async function getPool(host: AgentHost, name = "default"): Promise<{ pool: sql.ConnectionPool; entry: MssqlEntry }> {
  const mssql = host.mssql
  const resolvedName = mssql.databases.has(name)
    ? name
    : (name === "default" && mssql.databases.size > 0)
      ? (mssql.defaultConnection.value && mssql.databases.has(mssql.defaultConnection.value)
          ? mssql.defaultConnection.value
          : mssql.databases.keys().next().value as string)
      : name
  const entry = mssql.databases.get(resolvedName)
  if (!entry) {
    const available = Array.from(mssql.databases.keys()).join(", ") || "none"
    throw new Error(
      `MSSQL connection "${name}" not configured. Available: ${available}.`,
    )
  }
  if (entry.pool?.connected) return { pool: entry.pool, entry }
  if (entry.pool) {
    try { await entry.pool.close() } catch { }
  }
  entry.pool = new sql.ConnectionPool(entry.config)
  await entry.pool.connect()
  return { pool: entry.pool, entry }
}