/**
 * Trigger probing + best-effort archive emission for the sync execute path.
 *
 * The pre-flight `probeTriggers()` runs ONCE before tx.begin() so the
 * per-table `maybeArchive()` lookups don't block on Sch-S waits while
 * the transaction holds Sch-M locks (~60s lock_timeout × N tables).
 *
 * Real archive copy is not implemented engine-side — the documented
 * production convention relies on target-side AFTER triggers. We emit
 * `sync.execute.archive.skipped` for tables without triggers so the
 * operator knows SCD2 history will not be captured for that run.
 *
 * @module
 */

import type { ConnectionPool } from "mssql"
import type { AgentHost } from "../../application/shell/runtime.js"
import { EventType } from "../../domain/enums/event.js"
import { tableHasTriggers } from "../catalog-drift.js"
import { type SyncPlan } from "../plan-store.js"
import { emitSyncEvent as emit, type SyncSqlTraceContext } from "../sync-events.js"
import { trackedQuery } from "./db-helpers.js"

/**
 * Batch-probe target triggers for ALL upsert tables in one query so the
 * per-table fallback inside `maybeArchive` only fires for the rare case
 * where the batch query failed.
 */
export async function probeTriggers(
  host: AgentHost,
  tgtPool: ConnectionPool,
  planId: string,
  target: string,
  upsertTables: string[],
  syncTrace: SyncSqlTraceContext | null = null,
): Promise<Map<string, boolean>> {
  const triggerCache = new Map<string, boolean>()
  if (upsertTables.length === 0) return triggerCache
  const probeT0 = Date.now()
  try {
    const pairs = upsertTables.map((tn) => {
      const [s, n] = tn.split(".")
      return `('${(s ?? "").replace(/'/g, "''")}','${(n ?? "").replace(/'/g, "''")}')`
    }).join(",")
    const sqlText =
      `WITH wanted(s,n) AS (SELECT * FROM (VALUES ${pairs}) v(s,n)) ` +
      `SELECT s.name AS schemaName, o.name AS tableName, ` +
      `  COUNT(t.object_id) AS triggerCount ` +
      `FROM wanted w ` +
      `JOIN sys.schemas s ON s.name = w.s ` +
      `JOIN sys.objects o ON o.schema_id = s.schema_id AND o.name = w.n ` +
      `LEFT JOIN sys.triggers t ON t.parent_id = o.object_id AND t.is_disabled = 0 ` +
      `GROUP BY s.name, o.name`
    const r = await trackedQuery(host, tgtPool.request(), sqlText, "trigger-probe.batch", target, syncTrace)
    for (const row of r.recordset as Array<{ schemaName: string; tableName: string; triggerCount: number }>) {
      triggerCache.set(`${row.schemaName}.${row.tableName}`, row.triggerCount > 0)
    }
    emit(host, EventType.SyncExecuteArchiveProbeBatch, {
      planId, tables: upsertTables.length, durationMs: Date.now() - probeT0,
    })
  } catch (e) {
    // Best-effort: if the batch probe fails, the per-table fallback in
    // maybeArchive will still log a skipped event with hasTriggers=false.
    console.warn(`[sync.execute] batch trigger-probe failed:`, e)
  }
  return triggerCache
}

/**
 * Optional archive write before mutating a table. Honors ABI's documented
 * convention: if the target table already has active AFTER triggers, the
 * triggers handle archive — we skip. Otherwise we attempt a snapshot copy
 * of rows about-to-change into the archive sibling table (when one exists).
 *
 * Best-effort: failures here NEVER abort the sync (logged as a warning).
 * The trigger-based path is the production-default per the original plan.
 */
export async function maybeArchive(
  host: AgentHost,
  plan: SyncPlan,
  tableName: string,
  triggerCache?: Map<string, boolean>,
  _syncTrace: SyncSqlTraceContext | null = null,
): Promise<void> {
  // Resolve archive sibling for this table.
  const tIdx = plan.recipeSnapshot.tables.findIndex((rt) => rt.name === tableName)
  if (tIdx < 0) return
  // archiveTables may not exist on the recipe snapshot (older plans) — bail.
  // Real archive copy needs a column list and SCD2-aware WHERE clauses that
  // we cannot derive without live schema introspection inside the tx; the
  // safer default (and the documented production convention) is to rely on
  // target-side triggers. We probe once and emit a warning when neither
  // path is wired so the operator knows whether SCD2 history is captured.
  try {
    // Prefer the pre-flight cache; fall back to a live probe only when the
    // batch query failed (rare) or the cache wasn't supplied.
    let hasTriggers: boolean
    let cached: boolean
    const probeT0 = Date.now()
    if (triggerCache && triggerCache.has(tableName)) {
      hasTriggers = triggerCache.get(tableName)!
      cached = true
    } else {
      hasTriggers = await tableHasTriggers(host, plan.target, tableName)
      cached = false
    }
    emit(host, EventType.SyncExecuteArchiveProbe, {
      planId: plan.planId,
      table: tableName,
      hasTriggers,
      cached,
      durationMs: Date.now() - probeT0,
    })
    if (!hasTriggers) {
      emit(host, EventType.SyncExecuteArchiveSkipped, {
        planId: plan.planId,
        table: tableName,
        reason:
          "target has no active triggers and engine-side archive not yet implemented — SCD2 history will NOT be captured for this run",
      })
    }
  } catch (e) {
    console.warn(`[sync.archive] trigger-probe failed for ${tableName}:`, e)
  }
}
