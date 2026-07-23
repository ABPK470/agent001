/**
 * Retrying MSSQL query runner for the diff engine (pool gate + telemetry).
 */

import type sql from "mssql"
import { getPool } from "../../adapters/mssql/connection.js"
import { withPoolSlot } from "../../adapters/mssql/pool-gate.js"
import { isTransientMssqlError } from "../../core/diff-engine/sql-helpers.js"
import { EventType } from "../../domain/enums.js"
import type { SyncTelemetryContext } from "../../ports/events.js"
import type { MssqlAccessHost, SyncEnvironmentRegistryHost, SyncEventHost } from "../../ports/host.js"
import { emitSyncEvent, emitSyncSqlEvent } from "../events.js"

/**
 * Run a query with bounded retries on transient connection failures.
 * Holds a pool gate slot for the full attempt (including retries).
 * Backoff: 100ms, 400ms (jittered).
 */
export async function runQueryWithRetry<T = unknown>(
  host: SyncEventHost & MssqlAccessHost & SyncEnvironmentRegistryHost,
  connectionName: string,
  query: string,
  label: string,
  maxRetries = 2,
  telemetryContext?: SyncTelemetryContext
): Promise<sql.IResult<T>> {
  return withPoolSlot(host, connectionName, async () => {
    const { pool } = await getPool(host, connectionName)
    const t0 = Date.now()
    let lastErr: unknown
    let attempts = 0
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts = attempt + 1
      try {
        const result = await pool.request().query<T>(query)
        emitSyncSqlEvent(
          host,
          {
            label,
            connection: connectionName,
            sql: query,
            durationMs: Date.now() - t0,
            rowCount:
              result.recordset?.length ?? result.rowsAffected?.reduce((a: number, b: number) => a + b, 0) ?? 0,
            attempts
          },
          telemetryContext
        )
        return result
      } catch (e) {
        lastErr = e
        if (attempt === maxRetries || !isTransientMssqlError(e)) {
          emitSyncSqlEvent(
            host,
            {
              label,
              connection: connectionName,
              sql: query,
              durationMs: Date.now() - t0,
              attempts,
              error: e instanceof Error ? e.message : String(e)
            },
            telemetryContext
          )
          throw e
        }
        const delay = 100 * Math.pow(4, attempt) + Math.floor(Math.random() * 50)
        const errMsg = e instanceof Error ? e.message : String(e)
        console.warn(
          `[sync.diff] transient error on ${label} (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg} — retrying in ${delay}ms`
        )
        emitSyncEvent(host, EventType.SyncRetry, {
          phase: "diff",
          connection: connectionName,
          label,
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          error: errMsg,
          delayMs: delay
        })
        await new Promise((r) => setTimeout(r, delay))
      }
    }
    throw lastErr
  })
}
