/**
 * Sync audit log — sync-scoped audit trail keyed by plan_id.
 *
 * Replaces the old hack of stuffing 'sync:<planId>' into audit_log.run_id.
 * Cascades with the parent sync_runs row, so cleaning up sync history is
 * a single DELETE FROM sync_runs and audit rows go with it.
 */

import { getDb } from "./connection.js"

export interface SyncAuditRow {
  id: number
  plan_id: string
  actor: string
  actor_upn: string | null
  action: string
  detail: string
  timestamp: string
}

export interface RecordSyncAuditInput {
  planId: string
  actor: string
  actorUpn: string | null
  action: string
  detail: Record<string, unknown>
}

export function recordSyncAudit(i: RecordSyncAuditInput): void {
  getDb()
    .prepare(
      `
    INSERT INTO sync_audit (plan_id, actor, actor_upn, action, detail, timestamp)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `
    )
    .run(i.planId, i.actor, i.actorUpn, i.action, JSON.stringify(i.detail))
}

export function listSyncAuditForPlan(planId: string): SyncAuditRow[] {
  return getDb()
    .prepare(`SELECT * FROM sync_audit WHERE plan_id = ? ORDER BY timestamp`)
    .all(planId) as SyncAuditRow[]
}

export function listRecentSyncAudit(limit = 100, opts?: { actorUpn?: string | null }): SyncAuditRow[] {
  if (opts?.actorUpn) {
    return getDb()
      .prepare(`SELECT * FROM sync_audit WHERE actor_upn = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(opts.actorUpn, limit) as SyncAuditRow[]
  }
  return getDb()
    .prepare(`SELECT * FROM sync_audit ORDER BY timestamp DESC LIMIT ?`)
    .all(limit) as SyncAuditRow[]
}
