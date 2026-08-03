/**
 * Sync audit log — sync-scoped audit trail keyed by plan_id.
 *
 * Replaces the old hack of stuffing 'sync:<planId>' into audit_log.run_id.
 * Cascades with the parent sync_runs row, so cleaning up sync history is
 * a single DELETE FROM sync_runs and audit rows go with it.
 */

import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec } from "../../../schema/execute.js"
import { platformNow } from "../../../schema/sql-time.js"

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
  const compiled = getPlatformDb()
    .insertInto("sync_audit")
    .values({
      plan_id: i.planId,
      actor: i.actor,
      actor_upn: i.actorUpn,
      action: i.action,
      detail: JSON.stringify(i.detail),
      timestamp: platformNow(),
    })
    .compile()
  runExec(compiled)
}

export function listSyncAuditForPlan(planId: string): SyncAuditRow[] {
  const compiled = getPlatformDb()
    .selectFrom("sync_audit")
    .selectAll()
    .where("plan_id", "=", planId)
    .orderBy("timestamp")
    .compile()
  return runAll<SyncAuditRow>(compiled)
}

export function listRecentSyncAudit(limit = 100, opts?: { actorUpn?: string | null }): SyncAuditRow[] {
  let query = getPlatformDb().selectFrom("sync_audit").selectAll()
  if (opts?.actorUpn) {
    query = query.where("actor_upn", "=", opts.actorUpn)
  }
  const compiled = query.orderBy("timestamp", "desc").limit(limit).compile()
  return runAll<SyncAuditRow>(compiled)
}
