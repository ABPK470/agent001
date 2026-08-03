/**
 * Dialect-aware warehouse SQL execute — mssql | postgres via WarehousePoolProvider.
 */

import type { ConnectionPool } from "mssql"
import type { Pool as PgPool } from "pg"
import { executeMssqlQuery } from "../adapters/mssql/query.js"
import { withPoolSlot } from "../adapters/mssql/pool-gate.js"
import { executePostgresQuery } from "../adapters/postgres/query.js"
import { isTransientSqlError } from "@mia/sql-kit"
import { EventType } from "../domain/enums.js"
import type { SyncTelemetryContext } from "../ports/events.js"
import type { SyncRuntimeHost } from "../ports/host.js"
import type { WarehouseQueryResult } from "../ports/warehouse-query.js"
import { emitSyncEvent, emitSyncSqlEvent } from "./events.js"
import { resolveWarehousePool } from "./warehouse-connection.js"

async function executeOnHandle<T>(
  handle: Awaited<ReturnType<typeof resolveWarehousePool>>,
  sqlText: string,
): Promise<WarehouseQueryResult<T>> {
  if (handle.dialect === "mssql") {
    return executeMssqlQuery<T>(handle.pool as ConnectionPool, sqlText)
  }
  return executePostgresQuery<T>(handle.pool as PgPool, sqlText)
}

async function withWarehouseBudget<T>(
  host: SyncRuntimeHost,
  connectionName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const warehouseBudget = host.sync.warehousePools?.runWithSyncBudget
  if (warehouseBudget) {
    const env = host.sync.environments.items.get(connectionName)
    const key = env?.connectorId ?? connectionName
    return warehouseBudget(key, fn)
  }
  return withPoolSlot(host, connectionName, fn)
}

/**
 * Run one SQL batch against the warehouse for `connectionName` (env name).
 * Holds a sync budget / pool gate slot for the call.
 */
export async function runWarehouseQuery<T = Record<string, unknown>>(
  host: SyncRuntimeHost,
  connectionName: string,
  sqlText: string,
): Promise<WarehouseQueryResult<T>> {
  return withWarehouseBudget(host, connectionName, async () => {
    const handle = await resolveWarehousePool(host, connectionName)
    return executeOnHandle<T>(handle, sqlText)
  })
}

/**
 * Retrying warehouse query with Sync SQL telemetry (replaces MSSQL-only path).
 */
export async function runQueryWithRetry<T = unknown>(
  host: SyncRuntimeHost,
  connectionName: string,
  query: string,
  label: string,
  maxRetries = 2,
  telemetryContext?: SyncTelemetryContext,
): Promise<WarehouseQueryResult<T>> {
  return withWarehouseBudget(host, connectionName, async () => {
    const handle = await resolveWarehousePool(host, connectionName)
    const t0 = Date.now()
    let lastErr: unknown
    let attempts = 0
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts = attempt + 1
      try {
        const result = await executeOnHandle<T>(handle, query)
        emitSyncSqlEvent(
          host,
          {
            label,
            connection: connectionName,
            sql: query,
            durationMs: Date.now() - t0,
            rowCount:
              result.recordset.length ||
              result.rowsAffected.reduce((a, b) => a + b, 0),
            attempts,
          },
          telemetryContext,
        )
        return result
      } catch (e) {
        lastErr = e
        if (attempt === maxRetries || !isTransientSqlError(e)) {
          emitSyncSqlEvent(
            host,
            {
              label,
              connection: connectionName,
              sql: query,
              durationMs: Date.now() - t0,
              attempts,
              error: e instanceof Error ? e.message : String(e),
            },
            telemetryContext,
          )
          throw e
        }
        const delay = 100 * Math.pow(4, attempt) + Math.floor(Math.random() * 50)
        const errMsg = e instanceof Error ? e.message : String(e)
        console.warn(
          `[sync.diff] transient error on ${label} (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg} — retrying in ${delay}ms`,
        )
        emitSyncEvent(host, EventType.SyncRetry, {
          phase: "diff",
          connection: connectionName,
          label,
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          error: errMsg,
          delayMs: delay,
        })
        await new Promise((r) => setTimeout(r, delay))
      }
    }
    throw lastErr
  })
}
