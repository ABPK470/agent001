import { sql } from "kysely"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"

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
  const compiled = getPlatformDb()
    .selectFrom("proposer_schedule_configs")
    .selectAll()
    .where("enabled", "=", 1)
    .compile()
  return runAll<ProposerScheduleRow>(compiled)
}

export function advanceProposerSchedule(
  tenantId: string,
  source: string,
  target: string,
  lastRunAt: string,
  nextRunAt: string | null
): void {
  const compiled = getPlatformDb()
    .updateTable("proposer_schedule_configs")
    .set({ last_run_at: lastRunAt, next_run_at: nextRunAt })
    .where("tenant_id", "=", tenantId)
    .where("source", "=", source)
    .where("target", "=", target)
    .compile()
  runExec(compiled)
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
  const compiled = getPlatformDb()
    .insertInto("proposer_schedule_configs")
    .values({
      tenant_id: input.tenantId,
      source: input.source,
      target: input.target,
      cron: input.cron,
      enabled: input.enabled,
      next_run_at: input.nextRunAt,
      updated_at: sql`datetime('now')`,
      updated_by: input.updatedBy,
    })
    .onConflict((oc) =>
      oc.columns(["tenant_id", "source", "target"]).doUpdateSet({
        cron: input.cron,
        enabled: input.enabled,
        next_run_at: input.nextRunAt,
        updated_at: sql`datetime('now')`,
        updated_by: input.updatedBy,
      }),
    )
    .compile()
  runExec(compiled)
}

export function getProposerSchedule(
  tenantId: string,
  source: string,
  target: string
): ProposerScheduleRow | null {
  const compiled = getPlatformDb()
    .selectFrom("proposer_schedule_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("source", "=", source)
    .where("target", "=", target)
    .compile()
  return runGet<ProposerScheduleRow>(compiled) ?? null
}

export function listProposerSchedules(tenantId: string): ProposerScheduleRow[] {
  const compiled = getPlatformDb()
    .selectFrom("proposer_schedule_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .orderBy("source")
    .orderBy("target")
    .compile()
  return runAll<ProposerScheduleRow>(compiled)
}

export function deleteProposerSchedule(tenantId: string, source: string, target: string): void {
  const compiled = getPlatformDb()
    .deleteFrom("proposer_schedule_configs")
    .where("tenant_id", "=", tenantId)
    .where("source", "=", source)
    .where("target", "=", target)
    .compile()
  runExec(compiled)
}
