/**
 * Data lifecycle — reset, pruning, and stats.
 */

import { sql } from "kysely"
import { getDb } from "../connection.js"
import { getPlatformDb, getPlatformDbKind } from "../../../schema/kysely.js"
import { runAllAsync, runChangesAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"

// ── Data reset (preserve policies + layout_configs) ─────────────────────

export async function clearTransactionalData(): Promise<void> {
  // Deleting runs cascades to audit_log, checkpoints, run_log, token_usage,
  // trace_entries, notifications (where run-scoped), effects, file_snapshots,
  // attachment_imports, and attachments owned by those runs.
  await runExecAsync(getPlatformDb().deleteFrom("runs").where("id", "is not", null).compile())
  // System-wide notifications (run_id IS NULL) survive a `runs` purge —
  // wipe them explicitly so the inbox is empty after reset.
  await runExecAsync(getPlatformDb().deleteFrom("notifications").where("id", "is not", null).compile())
  try {
    await runExecAsync(getPlatformDb().deleteFrom("api_request_log").where("id", "is not", null).compile())
  } catch (err: unknown) {
    console.error("[mia]", err)
  }
}

/**
 * Delete rows outside the newest `keep` by created_at — portable across
 * SQLite (LIMIT) and MSSQL (OFFSET/FETCH). Used for retention pruning only.
 */
async function pruneKeepingNewest(
  table: "api_request_log" | "notifications" | "event_log",
  keep: number,
): Promise<number> {
  if (keep < 0) return 0
  const kind = getPlatformDbKind()
  if (kind === "sqlite" || kind === "postgres") {
    return await runChangesAsync(
      sql`
        DELETE FROM ${sql.table(table)} WHERE id NOT IN (
          SELECT id FROM ${sql.table(table)} ORDER BY created_at DESC LIMIT ${keep}
        )
      `.compile(getPlatformDb()),
    )
  }
  // MSSQL: keep the newest N ids, delete the rest.
  const keepRows = await runAllAsync<{ id: string | number }>(
    sql`
      SELECT id FROM ${sql.table(table)}
      ORDER BY created_at DESC
      OFFSET 0 ROWS FETCH NEXT ${keep} ROWS ONLY
    `.compile(getPlatformDb()),
  )
  if (keepRows.length === 0) {
    return await runChangesAsync(
      sql`DELETE FROM ${sql.table(table)}`.compile(getPlatformDb()),
    )
  }
  const keepIds = keepRows.map((r) => r.id)
  return await runChangesAsync(
    getPlatformDb().deleteFrom(table).where("id", "not in", keepIds).compile(),
  )
}

// ── Data lifecycle / pruning ─────────────────────────────────────

/**
 * Prune transient observability rows (api_request_log, notifications,
 * event_log) to keep the store from growing without bound.
 *
 * **Runs are NEVER pruned implicitly.** They represent user work
 * (goals + their trace, audit, attachments) and are the durable record
 * a user expects to find when they log back in. Deleting a run also
 * cascade-deletes its audit_log / checkpoints / run_log / token_usage /
 * trace_entries / effects / file_snapshots / attachment_imports /
 * notifications rows, which is too destructive to do on a schedule.
 *
 * To prune runs the caller must explicitly pass `keepRuns` (admin-only
 * `POST /api/db/prune`); omitting it leaves every run in place. The
 * total-reset endpoint `DELETE /api/data` (admin-only) is the only
 * supported "wipe everything" path and goes through
 * `clearTransactionalData()`.
 */
export async function pruneOldData(opts?: {
  keepRuns?: number
  keepApiRequests?: number
  keepNotifications?: number
  keepEvents?: number
}): Promise<{
  prunedRuns: number
  prunedApiRequests: number
  prunedNotifications: number
  prunedEvents: number
  vacuumed: boolean
}> {
  const kind = getPlatformDbKind()
  // keepRuns defaults to `undefined` → no run pruning. Operators that
  // really want a cap must opt in via the admin endpoint.
  const keepRuns = opts?.keepRuns
  const keepApiRequests = opts?.keepApiRequests ?? 10_000
  const keepNotifications = opts?.keepNotifications ?? 1000
  const keepEvents = opts?.keepEvents ?? 50_000

  let prunedRuns = 0
  if (typeof keepRuns === "number" && keepRuns >= 0) {
    const completedStatuses = ["completed", "failed", "cancelled"] as const
    let runsToPrune: { id: string }[]
    if (kind === "sqlite") {
      // SQLite LIMIT -1 OFFSET n ≡ "all rows after the first n".
      runsToPrune = await runAllAsync<{ id: string }>(
        sql`
          SELECT id FROM runs
          WHERE status IN ('completed', 'failed', 'cancelled')
          ORDER BY created_at DESC
          LIMIT -1 OFFSET ${keepRuns}
        `.compile(getPlatformDb()),
      )
    } else if (kind === "postgres") {
      runsToPrune = await runAllAsync<{ id: string }>(
        sql`
          SELECT id FROM runs
          WHERE status IN ('completed', 'failed', 'cancelled')
          ORDER BY created_at DESC
          OFFSET ${keepRuns}
        `.compile(getPlatformDb()),
      )
    } else {
      const keepIds = await runAllAsync<{ id: string }>(
        sql`
          SELECT id FROM runs
          WHERE status IN ('completed', 'failed', 'cancelled')
          ORDER BY created_at DESC
          OFFSET 0 ROWS FETCH NEXT ${keepRuns} ROWS ONLY
        `.compile(getPlatformDb()),
      )
      if (keepIds.length === 0) {
        runsToPrune = await runAllAsync<{ id: string }>(
          getPlatformDb()
            .selectFrom("runs")
            .select("id")
            .where("status", "in", [...completedStatuses])
            .compile(),
        )
      } else {
        runsToPrune = await runAllAsync<{ id: string }>(
          getPlatformDb()
            .selectFrom("runs")
            .select("id")
            .where("status", "in", [...completedStatuses])
            .where(
              "id",
              "not in",
              keepIds.map((r) => r.id),
            )
            .compile(),
        )
      }
    }

    if (runsToPrune.length > 0) {
      const ids = runsToPrune.map((r) => r.id)
      await runExecAsync(getPlatformDb().deleteFrom("runs").where("id", "in", ids).compile())
      prunedRuns = ids.length
    }
  }

  const prunedApiRequests = await pruneKeepingNewest("api_request_log", keepApiRequests)
  const prunedNotifications = await pruneKeepingNewest("notifications", keepNotifications)

  let prunedEvents = 0
  try {
    prunedEvents = await pruneKeepingNewest("event_log", keepEvents)
  } catch (err: unknown) {
    console.error("[mia]", err)
  }

  let vacuumed = false
  if (
    kind === "sqlite" &&
    (prunedRuns > 50 || prunedApiRequests > 1000 || prunedEvents > 5000)
  ) {
    getDb().pragma("wal_checkpoint(TRUNCATE)")
    vacuumed = true
  }

  return { prunedRuns, prunedApiRequests, prunedNotifications, prunedEvents, vacuumed }
}

// ── Stats ────────────────────────────────────────────────────────

export async function getDbStats(): Promise<Record<string, number>> {
  const kind = getPlatformDbKind()
  const tables = [
    "runs",
    "audit_log",
    "run_log",
    "trace_entries",
    "token_usage",
    "checkpoints",
    "effects",
    "file_snapshots",
    "notifications",
    "api_request_log",
    "event_log",
    "webhook_drain_configs",
  ] as const
  const stats: Record<string, number> = {}
  for (const t of tables) {
    try {
      const compiled = sql<{ count: number }>`select count(*) as count from ${sql.table(t)}`.compile(
        getPlatformDb(),
      )
      const row = await runGetAsync<{ count: number | bigint }>(compiled)
      stats[t] = Number(row?.count ?? 0)
    } catch {
      stats[t] = -1
    }
  }
  if (kind === "sqlite") {
    const db = getDb()
    const pageCount = (db.pragma("page_count") as { page_count: number }[])[0]?.page_count ?? 0
    const pageSize = (db.pragma("page_size") as { page_size: number }[])[0]?.page_size ?? 4096
    stats["db_size_bytes"] = pageCount * pageSize
  } else {
    stats["db_size_bytes"] = -1
  }
  return stats
}
