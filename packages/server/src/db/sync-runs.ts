/**
 * Persistence for ABI sync runs.
 *
 * One row per `executeSync` invocation (success OR failure). Survives server
 * restarts via SQLite. Joined to `sessions` by `actor_upn` for "who synced
 * what to where" audit queries.
 */

import { getDb } from "./connection.js"

export interface SyncRunRow {
  plan_id: string
  entity_type: string
  entity_id: string
  entity_display_name: string | null
  source: string
  target: string
  actor_upn: string | null
  preview_totals_json: string
  execute_totals_json: string | null
  status: "started" | "success" | "failed"
  error: string | null
  drift_detected_pct: number | null
  started_at: string
  finished_at: string | null
  duration_ms: number | null
}

export interface RecordSyncRunStartInput {
  planId: string
  entityType: string
  entityId: string | number
  entityDisplayName: string | null
  source: string
  target: string
  actorUpn: string | null
  previewTotals: unknown
}

export function recordSyncRunStart(i: RecordSyncRunStartInput): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO sync_runs
       (plan_id, entity_type, entity_id, entity_display_name, source, target,
        actor_upn, preview_totals_json, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'started', datetime('now'))`,
    )
    .run(
      i.planId,
      i.entityType,
      String(i.entityId),
      i.entityDisplayName,
      i.source,
      i.target,
      i.actorUpn,
      JSON.stringify(i.previewTotals),
    )
}

export interface RecordSyncRunFinishInput {
  planId: string
  status: "success" | "failed"
  error?: string | null
  executeTotals?: unknown
  driftDetectedPct?: number | null
  durationMs: number
}

export function recordSyncRunFinish(i: RecordSyncRunFinishInput): void {
  getDb()
    .prepare(
      `UPDATE sync_runs
       SET status = ?, error = ?, execute_totals_json = ?, drift_detected_pct = ?,
           finished_at = datetime('now'), duration_ms = ?
       WHERE plan_id = ?`,
    )
    .run(
      i.status,
      i.error ?? null,
      i.executeTotals ? JSON.stringify(i.executeTotals) : null,
      i.driftDetectedPct ?? null,
      i.durationMs,
      i.planId,
    )
}

export function listSyncRuns(limit = 50): SyncRunRow[] {
  return getDb()
    .prepare(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as SyncRunRow[]
}

export function getSyncRun(planId: string): SyncRunRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM sync_runs WHERE plan_id = ?`)
    .get(planId) as SyncRunRow | undefined
}
