import { getDb } from "../connection.js"

export interface ProposerScheduleRow {
  tenant_id: string
  source: string
  target: string
  cron: string
  enabled: number
  last_run_at: string | null
  next_run_at: string | null
}

export function listEnabledProposerSchedules(): ProposerScheduleRow[] {
  return getDb()
    .prepare(`SELECT * FROM proposer_schedule_configs WHERE enabled = 1`)
    .all() as ProposerScheduleRow[]
}

export function advanceProposerSchedule(
  tenantId: string,
  source: string,
  target: string,
  lastRunAt: string,
  nextRunAt: string | null
): void {
  getDb()
    .prepare(
      `
    UPDATE proposer_schedule_configs
       SET last_run_at = ?, next_run_at = ?
     WHERE tenant_id = ? AND source = ? AND target = ?
  `
    )
    .run(lastRunAt, nextRunAt, tenantId, source, target)
}

export function upsertProposerSchedule(input: {
  tenantId: string
  source: string
  target: string
  cron: string
  enabled: number
  nextRunAt: string | null
  updatedBy: string
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO proposer_schedule_configs (tenant_id, source, target, cron, enabled, next_run_at, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(tenant_id, source, target) DO UPDATE SET
      cron        = excluded.cron,
      enabled     = excluded.enabled,
      next_run_at = excluded.next_run_at,
      updated_at  = excluded.updated_at,
      updated_by  = excluded.updated_by
  `
    )
    .run(
      input.tenantId,
      input.source,
      input.target,
      input.cron,
      input.enabled,
      input.nextRunAt,
      input.updatedBy
    )
}

export function getProposerSchedule(
  tenantId: string,
  source: string,
  target: string
): ProposerScheduleRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM proposer_schedule_configs WHERE tenant_id = ? AND source = ? AND target = ?`)
      .get(tenantId, source, target) as ProposerScheduleRow | undefined) ?? null
  )
}

export function listProposerSchedules(tenantId: string): ProposerScheduleRow[] {
  return getDb()
    .prepare(`SELECT * FROM proposer_schedule_configs WHERE tenant_id = ? ORDER BY source, target`)
    .all(tenantId) as ProposerScheduleRow[]
}

export function deleteProposerSchedule(tenantId: string, source: string, target: string): void {
  getDb()
    .prepare(`DELETE FROM proposer_schedule_configs WHERE tenant_id = ? AND source = ? AND target = ?`)
    .run(tenantId, source, target)
}
