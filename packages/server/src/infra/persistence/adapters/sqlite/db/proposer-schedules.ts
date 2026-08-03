import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"
import { platformNow } from "../../../schema/sql-time.js"
import { upsertRowAsync } from "../../../schema/upsert.js"

export interface ProposerScheduleRow {
  tenant_id: string
  source: string
  target: string
  cron: string
  enabled: number
  last_run_at: string | null
  next_run_at: string | null
}

export async function listEnabledProposerSchedules(): Promise<ProposerScheduleRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("proposer_schedule_configs")
    .selectAll()
    .where("enabled", "=", 1)
    .compile()
  return await runAllAsync<ProposerScheduleRow>(compiled)
}

export async function advanceProposerSchedule(
  tenantId: string,
  source: string,
  target: string,
  lastRunAt: string,
  nextRunAt: string | null
): Promise<void> {
  const compiled = getPlatformDb()
    .updateTable("proposer_schedule_configs")
    .set({ last_run_at: lastRunAt, next_run_at: nextRunAt })
    .where("tenant_id", "=", tenantId)
    .where("source", "=", source)
    .where("target", "=", target)
    .compile()
  await runExecAsync(compiled)
}

export async function upsertProposerSchedule(input: {
  tenantId: string
  source: string
  target: string
  cron: string
  enabled: number
  nextRunAt: string | null
  updatedBy: string
}): Promise<void> {
  const now = platformNow()
  await upsertRowAsync({
    table: "proposer_schedule_configs",
    keys: {
      tenant_id: input.tenantId,
      source: input.source,
      target: input.target,
    },
    insert: {
      tenant_id: input.tenantId,
      source: input.source,
      target: input.target,
      cron: input.cron,
      enabled: input.enabled,
      next_run_at: input.nextRunAt,
      updated_at: now,
      updated_by: input.updatedBy,
    },
    update: {
      cron: input.cron,
      enabled: input.enabled,
      next_run_at: input.nextRunAt,
      updated_at: now,
      updated_by: input.updatedBy,
    },
  })
}

export async function getProposerSchedule(
  tenantId: string,
  source: string,
  target: string
): Promise<ProposerScheduleRow | null> {
  const compiled = getPlatformDb()
    .selectFrom("proposer_schedule_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("source", "=", source)
    .where("target", "=", target)
    .compile()
  return await runGetAsync<ProposerScheduleRow>(compiled) ?? null
}

export async function listProposerSchedules(tenantId: string): Promise<ProposerScheduleRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("proposer_schedule_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .orderBy("source")
    .orderBy("target")
    .compile()
  return await runAllAsync<ProposerScheduleRow>(compiled)
}

export async function deleteProposerSchedule(tenantId: string, source: string, target: string): Promise<void> {
  const compiled = getPlatformDb()
    .deleteFrom("proposer_schedule_configs")
    .where("tenant_id", "=", tenantId)
    .where("source", "=", source)
    .where("target", "=", target)
    .compile()
  await runExecAsync(compiled)
}
