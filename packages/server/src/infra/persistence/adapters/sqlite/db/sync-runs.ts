/**
 * Persistence for ABI sync runs.
 *
 * One row per `executeSync` invocation (success OR failure). Survives server
 * restarts via SQLite. Joined to `sessions` by `actor_upn` for "who synced
 * what to where" audit queries.
 */

import { isSyncRunStatus, SYNC_RUN_STATUSES, SyncRunStatus } from "@mia/shared-enums"
import type { SelectQueryBuilder } from "kysely"
import { sql } from "kysely"
import { requireSyncRunActorUpn } from "../../../sync-plan-actor.js"
import { rememberPlanOwner } from "../../../../../ports/run-owner-index.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"
import { platformNow } from "../../../schema/sql-time.js"
import { getRowByKeysAsync, upsertRowAsync } from "../../../schema/upsert.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import type { PlatformDatabase } from "../../../schema/tables.js"

export interface SyncRunRow {
  plan_id: string
  entity_type: string
  entity_id: string
  entity_display_name: string | null
  source: string
  target: string
  actor_upn: string
  preview_inserts: number
  preview_updates: number
  preview_deletes: number
  executed_inserts: number | null
  executed_updates: number | null
  executed_deletes: number | null
  preview_totals_json: string
  execute_totals_json: string | null
  status: SyncRunStatus
  error: string | null
  drift_detected_pct: number | null
  started_at: string
  finished_at: string | null
  duration_ms: number | null
}

interface CountTriple {
  insert?: number
  update?: number
  delete?: number
}

function asCounts(totals: unknown): CountTriple {
  if (totals && typeof totals === "object") {
    const t = totals as Record<string, unknown>
    return {
      insert: typeof t["insert"] === "number" ? (t["insert"] as number) : 0,
      update: typeof t["update"] === "number" ? (t["update"] as number) : 0,
      delete: typeof t["delete"] === "number" ? (t["delete"] as number) : 0
    }
  }
  return { insert: 0, update: 0, delete: 0 }
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

export async function recordSyncRunStart(i: RecordSyncRunStartInput): Promise<void> {
  const actorUpn = requireSyncRunActorUpn(i.actorUpn, "recordSyncRunStart")
  const c = asCounts(i.previewTotals)
  const now = platformNow()
  const existing = await getRowByKeysAsync<{ entity_display_name: string | null }>("sync_runs", {
    plan_id: i.planId,
  })
  const displayName = i.entityDisplayName ?? existing?.entity_display_name ?? null
  await upsertRowAsync({
    table: "sync_runs",
    keys: { plan_id: i.planId },
    insert: {
      plan_id: i.planId,
      entity_type: i.entityType,
      entity_id: String(i.entityId),
      entity_display_name: i.entityDisplayName,
      source: i.source,
      target: i.target,
      actor_upn: actorUpn,
      preview_inserts: c.insert ?? 0,
      preview_updates: c.update ?? 0,
      preview_deletes: c.delete ?? 0,
      preview_totals_json: JSON.stringify(i.previewTotals),
      status: SyncRunStatus.Started,
      started_at: now,
    },
    update: {
      entity_type: i.entityType,
      entity_id: String(i.entityId),
      entity_display_name: displayName,
      source: i.source,
      target: i.target,
      actor_upn: actorUpn,
      preview_inserts: c.insert ?? 0,
      preview_updates: c.update ?? 0,
      preview_deletes: c.delete ?? 0,
      preview_totals_json: JSON.stringify(i.previewTotals),
      status: SyncRunStatus.Started,
      started_at: now,
      finished_at: null,
      duration_ms: null,
      error: null,
      executed_inserts: null,
      executed_updates: null,
      executed_deletes: null,
      execute_totals_json: null,
    },
  })
  rememberPlanOwner(i.planId, actorUpn)
}

export interface RecordSyncRunFinishInput {
  planId: string
  status:
    | typeof SyncRunStatus.Success
    | typeof SyncRunStatus.Failed
    | typeof SyncRunStatus.Skipped
    | typeof SyncRunStatus.Cancelled
  error?: string | null
  executeTotals?: unknown
  durationMs: number
}

export async function recordSyncRunFinish(i: RecordSyncRunFinishInput): Promise<void> {
  if (
    !isSyncRunStatus(i.status) ||
    (i.status !== SyncRunStatus.Success &&
      i.status !== SyncRunStatus.Failed &&
      i.status !== SyncRunStatus.Skipped &&
      i.status !== SyncRunStatus.Cancelled)
  ) {
    throw new Error(
      `recordSyncRunFinish.status must be 'success', 'failed', 'skipped', or 'cancelled' (one of [${SYNC_RUN_STATUSES.join(", ")}]); got "${String(i.status)}" for plan ${i.planId}`
    )
  }
  const c = i.executeTotals ? asCounts(i.executeTotals) : null
  if (i.executeTotals) {
    const compiled = getPlatformDb()
      .updateTable("sync_runs")
      .set({
        status: i.status,
        error: i.error ?? null,
        execute_totals_json: JSON.stringify(i.executeTotals),
        executed_inserts: c?.insert ?? 0,
        executed_updates: c?.update ?? 0,
        executed_deletes: c?.delete ?? 0,
        finished_at: platformNow(),
        duration_ms: i.durationMs,
      })
      .where("plan_id", "=", i.planId)
      .compile()
    await runExecAsync(compiled)
    return
  }

  const compiled = getPlatformDb()
    .updateTable("sync_runs")
    .set({
      status: i.status,
      error: i.error ?? null,
      finished_at: platformNow(),
      duration_ms: i.durationMs,
    })
    .where("plan_id", "=", i.planId)
    .compile()
  await runExecAsync(compiled)
}

export async function listSyncRuns(limit = 50): Promise<SyncRunRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("sync_runs")
    .selectAll()
    .orderBy("started_at", "desc")
    .limit(limit)
    .compile()
  return await runAllAsync<SyncRunRow>(compiled)
}

export type SyncRunHistorySort =
  | "started_desc"
  | "started_asc"
  | "finished_desc"
  | "finished_asc"

export interface SyncRunHistoryFilters {
  actorUpn?: string | null
  search?: string
  status?: SyncRunStatus[]
  entityType?: string
  source?: string
  target?: string
  startedAfter?: string
  startedBefore?: string
}

export interface ListSyncRunsPaginatedInput extends SyncRunHistoryFilters {
  page: number
  pageSize: number
  sort?: SyncRunHistorySort
}

type SyncRunSelectQuery = SelectQueryBuilder<PlatformDatabase, "sync_runs", object>

function applySyncRunHistoryFilters(
  query: SyncRunSelectQuery,
  filters: SyncRunHistoryFilters,
): SyncRunSelectQuery {
  let q = query
  if (filters.actorUpn) {
    q = q.where("actor_upn", "=", filters.actorUpn)
  }
  if (filters.status?.length) {
    q = q.where("status", "in", [...filters.status])
  }
  const entityType = filters.entityType?.trim()
  if (entityType) {
    q = q.where("entity_type", "=", entityType)
  }
  const source = filters.source?.trim()
  if (source) {
    q = q.where("source", "=", source)
  }
  const target = filters.target?.trim()
  if (target) {
    q = q.where("target", "=", target)
  }
  const startedAfter = filters.startedAfter?.trim()
  if (startedAfter) {
    q = q.where("started_at", ">=", startedAfter)
  }
  const startedBefore = filters.startedBefore?.trim()
  if (startedBefore) {
    q = q.where("started_at", "<=", `${startedBefore} 23:59:59`)
  }
  const search = filters.search?.trim()
  if (search) {
    const qLike = `%${search}%`
    q = q.where((eb) =>
      eb.or([
        eb("entity_display_name", "like", qLike),
        eb("entity_id", "like", qLike),
        eb("entity_type", "like", qLike),
        eb("plan_id", "like", qLike),
        eb("source", "like", qLike),
        eb("target", "like", qLike),
        eb("actor_upn", "like", qLike),
      ]),
    )
  }
  return q
}

function applySyncRunHistoryOrder(
  query: SyncRunSelectQuery,
  sort: SyncRunHistorySort = "started_desc",
): SyncRunSelectQuery {
  switch (sort) {
    case "started_asc":
      return query.orderBy("started_at", "asc")
    case "finished_desc":
      return query.orderBy(sql`finished_at is null`).orderBy("finished_at", "desc")
    case "finished_asc":
      return query.orderBy("finished_at", "asc")
    default:
      return query.orderBy("started_at", "desc")
  }
}

export async function countSyncRuns(filters: SyncRunHistoryFilters = {}): Promise<number> {
  const compiled = applySyncRunHistoryFilters(
    getPlatformDb().selectFrom("sync_runs").select(sql<number>`count(1)`.as("c")),
    filters,
  ).compile()
  const row = await runGetAsync<{ c: number }>(compiled)
  return row?.c ?? 0
}

export async function listSyncRunsPaginated(input: ListSyncRunsPaginatedInput): Promise<SyncRunRow[]> {
  const page = Math.max(1, input.page)
  const pageSize = Math.max(1, input.pageSize)
  const offset = (page - 1) * pageSize
  const compiled = applySyncRunHistoryOrder(
    applySyncRunHistoryFilters(getPlatformDb().selectFrom("sync_runs").selectAll(), input),
    input.sort,
  )
    .limit(pageSize)
    .offset(offset)
    .compile()
  return await runAllAsync<SyncRunRow>(compiled)
}

export async function getSyncRun(planId: string): Promise<SyncRunRow | undefined> {
  const compiled = getPlatformDb()
    .selectFrom("sync_runs")
    .selectAll()
    .where("plan_id", "=", planId)
    .compile()
  return await runGetAsync<SyncRunRow>(compiled)
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
export async function recordSyncRunPreview(i: {
  planId: string
  entityType: string
  entityId: string | number
  entityDisplayName: string | null
  source: string
  target: string
  actorUpn: string | null
  previewTotals: unknown
  planJson: string
}): Promise<void> {
  const actorUpn = requireSyncRunActorUpn(i.actorUpn, "recordSyncRunPreview")
  const c = asCounts(i.previewTotals)
  // Don't clobber an in-progress / completed run with a "preview" status.
  // On conflict only overwrite plan_json + preview metadata; leave status/timestamps.
  const existing = await getRowByKeysAsync<{ entity_display_name: string | null }>("sync_runs", {
    plan_id: i.planId,
  })
  const displayName = i.entityDisplayName ?? existing?.entity_display_name ?? null
  await upsertRowAsync({
    table: "sync_runs",
    keys: { plan_id: i.planId },
    insert: {
      plan_id: i.planId,
      entity_type: i.entityType,
      entity_id: String(i.entityId),
      entity_display_name: i.entityDisplayName,
      source: i.source,
      target: i.target,
      actor_upn: actorUpn,
      preview_inserts: c.insert ?? 0,
      preview_updates: c.update ?? 0,
      preview_deletes: c.delete ?? 0,
      preview_totals_json: JSON.stringify(i.previewTotals),
      plan_json: i.planJson,
      status: SyncRunStatus.Preview,
      started_at: platformNow(),
    },
    update: {
      plan_json: i.planJson,
      preview_totals_json: JSON.stringify(i.previewTotals),
      preview_inserts: c.insert ?? 0,
      preview_updates: c.update ?? 0,
      preview_deletes: c.delete ?? 0,
      entity_display_name: displayName,
    },
  })
}

/** Re-hydrate the full plan body for a given planId, or null if absent. */
export async function getSyncRunPlanJson(planId: string): Promise<string | null> {
  const compiled = getPlatformDb()
    .selectFrom("sync_runs")
    .select("plan_json")
    .where("plan_id", "=", planId)
    .compile()
  const row = await runGetAsync<{ plan_json: string | null }>(compiled)
  return row?.plan_json ?? null
}
