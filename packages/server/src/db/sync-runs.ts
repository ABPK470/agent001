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

/**
 * Persist a SyncPlan body for later re-hydration (e.g. History → "View plan"
 * after a server restart). Upserts a `sync_runs` row keyed by `planId`.
 *
 * - Called for *every* preview (UI- or agent-initiated) via the plan-store
 *   sink, so the row exists even when execute is never run.
 * - Status defaults to `"preview"` and is upgraded by `recordSyncRunStart` /
 *   `recordSyncRunFinish` when the plan is later executed.
 * - Stores a complete JSON snapshot of the plan in `plan_json`.
 */
export function recordSyncRunPreview(i: {
  planId: string
  entityType: string
  entityId: string | number
  entityDisplayName: string | null
  source: string
  target: string
  actorUpn: string | null
  previewTotals: unknown
  planJson: string
}): void {
  // Don't clobber an in-progress / completed run with a "preview" status.
  // Use INSERT … ON CONFLICT to only overwrite plan_json + preview metadata
  // for already-existing rows, leaving status / timestamps intact.
  getDb()
    .prepare(
      `INSERT INTO sync_runs
         (plan_id, entity_type, entity_id, entity_display_name, source, target,
          actor_upn, preview_totals_json, plan_json, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preview', datetime('now'))
       ON CONFLICT(plan_id) DO UPDATE SET
         plan_json = excluded.plan_json,
         preview_totals_json = excluded.preview_totals_json,
         entity_display_name = COALESCE(excluded.entity_display_name, sync_runs.entity_display_name)`,
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
      i.planJson,
    )
}

/** Re-hydrate the full plan body for a given planId, or null if absent. */
export function getSyncRunPlanJson(planId: string): string | null {
  const row = getDb()
    .prepare(`SELECT plan_json FROM sync_runs WHERE plan_id = ?`)
    .get(planId) as { plan_json: string | null } | undefined
  return row?.plan_json ?? null
}
