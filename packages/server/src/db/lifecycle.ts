/**
 * Data lifecycle — reset, pruning, and stats.
 */

import { getDb } from "./connection.js"

// ── Data reset (preserve policies + layouts) ─────────────────────

export function clearTransactionalData(): void {
  const db = getDb()
  // Deleting runs cascades to audit_log, checkpoints, logs, token_usage,
  // trace_entries, notifications (where run-scoped), effects, file_snapshots,
  // attachment_imports, and attachments owned by those runs.
  db.exec(`DELETE FROM runs;`)
  // System-wide notifications (run_id IS NULL) survive a `runs` purge —
  // wipe them explicitly so the inbox is empty after reset.
  db.exec(`DELETE FROM notifications;`)
  try { db.exec("DELETE FROM api_requests") } catch { /* table may not exist yet */ }
}

// ── Data lifecycle / pruning ─────────────────────────────────────

export function pruneOldData(opts?: {
  keepRuns?: number
  keepApiRequests?: number
  keepNotifications?: number
  keepEvents?: number
}): { prunedRuns: number; prunedApiRequests: number; prunedNotifications: number; prunedEvents: number; vacuumed: boolean } {
  const db = getDb()
  const keepRuns = opts?.keepRuns ?? 500
  const keepApiRequests = opts?.keepApiRequests ?? 10_000
  const keepNotifications = opts?.keepNotifications ?? 1000
  const keepEvents = opts?.keepEvents ?? 50_000

  const runsToPrune = db.prepare(`
    SELECT id FROM runs
    WHERE status IN ('completed', 'failed', 'cancelled')
    ORDER BY created_at DESC
    LIMIT -1 OFFSET ?
  `).all(keepRuns) as { id: string }[]

  let prunedRuns = 0
  if (runsToPrune.length > 0) {
    const ids = runsToPrune.map((r) => r.id)
    const placeholders = ids.map(() => "?").join(",")
    // ON DELETE CASCADE on every run-owned child handles the cleanup;
    // a single DELETE replaces the previous eight per-table DELETEs.
    db.prepare(`DELETE FROM runs WHERE id IN (${placeholders})`).run(...ids)
    prunedRuns = ids.length
  }

  const apiResult = db.prepare(`
    DELETE FROM api_requests WHERE id NOT IN (
      SELECT id FROM api_requests ORDER BY created_at DESC LIMIT ?
    )
  `).run(keepApiRequests)
  const prunedApiRequests = apiResult.changes

  const notifResult = db.prepare(`
    DELETE FROM notifications WHERE id NOT IN (
      SELECT id FROM notifications ORDER BY created_at DESC LIMIT ?
    )
  `).run(keepNotifications)
  const prunedNotifications = notifResult.changes

  let prunedEvents = 0
  try {
    const evtResult = db.prepare(`
      DELETE FROM event_log WHERE id NOT IN (
        SELECT id FROM event_log ORDER BY created_at DESC LIMIT ?
      )
    `).run(keepEvents)
    prunedEvents = evtResult.changes
  } catch { /* table may not exist yet */ }

  let vacuumed = false
  if (prunedRuns > 50 || prunedApiRequests > 1000 || prunedEvents > 5000) {
    db.pragma("wal_checkpoint(TRUNCATE)")
    vacuumed = true
  }

  return { prunedRuns, prunedApiRequests, prunedNotifications, prunedEvents, vacuumed }
}

// ── Stats ────────────────────────────────────────────────────────

export function getDbStats(): Record<string, number> {
  const db = getDb()
  const tables = ["runs", "audit_log", "logs", "trace_entries", "token_usage", "checkpoints",
    "effects", "file_snapshots", "notifications", "api_requests", "event_log", "webhook_drains"] as const
  const stats: Record<string, number> = {}
  for (const t of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as count FROM ${t}`).get() as { count: number }
      stats[t] = row.count
    } catch {
      stats[t] = -1
    }
  }
  const pageCount = (db.pragma("page_count") as { page_count: number }[])[0]?.page_count ?? 0
  const pageSize = (db.pragma("page_size") as { page_size: number }[])[0]?.page_size ?? 4096
  stats["db_size_bytes"] = pageCount * pageSize
  return stats
}
