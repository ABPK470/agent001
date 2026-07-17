/**
 * Persistence for ABI sync runs.
 *
 * One row per `executeSync` invocation (success OR failure). Survives server
 * restarts via SQLite. Joined to `sessions` by `actor_upn` for "who synced
 * what to where" audit queries.
 */

import { isSyncRunStatus, SYNC_RUN_STATUSES, SyncRunStatus } from "@mia/shared-enums"
import { requireSyncRunActorUpn } from "../sync-plan-actor.js"
import { getDb } from "../connection.js"

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

export function recordSyncRunStart(i: RecordSyncRunStartInput): void {
  const actorUpn = requireSyncRunActorUpn(i.actorUpn, "recordSyncRunStart")
  const c = asCounts(i.previewTotals)
  getDb()
    .prepare(
      `INSERT INTO sync_runs
         (plan_id, entity_type, entity_id, entity_display_name, source, target,
          actor_upn, preview_inserts, preview_updates, preview_deletes,
          preview_totals_json, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(plan_id) DO UPDATE SET
         entity_type = excluded.entity_type,
         entity_id = excluded.entity_id,
         entity_display_name = COALESCE(excluded.entity_display_name, sync_runs.entity_display_name),
         source = excluded.source,
         target = excluded.target,
         actor_upn = excluded.actor_upn,
         preview_inserts = excluded.preview_inserts,
         preview_updates = excluded.preview_updates,
         preview_deletes = excluded.preview_deletes,
         preview_totals_json = excluded.preview_totals_json,
         status = excluded.status,
         started_at = datetime('now'),
         finished_at = NULL,
         duration_ms = NULL,
         error = NULL,
         executed_inserts = NULL,
         executed_updates = NULL,
         executed_deletes = NULL,
         execute_totals_json = NULL`
    )
    .run(
      i.planId,
      i.entityType,
      String(i.entityId),
      i.entityDisplayName,
      i.source,
      i.target,
      actorUpn,
      c.insert ?? 0,
      c.update ?? 0,
      c.delete ?? 0,
      JSON.stringify(i.previewTotals),
      SyncRunStatus.Started
    )
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

export function recordSyncRunFinish(i: RecordSyncRunFinishInput): void {
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
    getDb()
      .prepare(
        `UPDATE sync_runs
         SET status = ?, error = ?, execute_totals_json = ?,
             executed_inserts = ?, executed_updates = ?, executed_deletes = ?,
             finished_at = datetime('now'), duration_ms = ?
         WHERE plan_id = ?`
      )
      .run(
        i.status,
        i.error ?? null,
        JSON.stringify(i.executeTotals),
        c?.insert ?? 0,
        c?.update ?? 0,
        c?.delete ?? 0,
        i.durationMs,
        i.planId
      )
    return
  }

  getDb()
    .prepare(
      `UPDATE sync_runs
       SET status = ?, error = ?,
           finished_at = datetime('now'), duration_ms = ?
       WHERE plan_id = ?`
    )
    .run(i.status, i.error ?? null, i.durationMs, i.planId)
}

export function listSyncRuns(limit = 50): SyncRunRow[] {
  return getDb()
    .prepare(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as SyncRunRow[]
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

function syncRunHistoryOrderBy(sort: SyncRunHistorySort = "started_desc"): string {
  switch (sort) {
    case "started_asc":
      return "started_at ASC"
    case "finished_desc":
      return "finished_at IS NULL, finished_at DESC"
    case "finished_asc":
      return "finished_at ASC"
    default:
      return "started_at DESC"
  }
}

function buildSyncRunHistoryWhere(filters: SyncRunHistoryFilters): { where: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []

  if (filters.actorUpn) {
    clauses.push("actor_upn = ?")
    params.push(filters.actorUpn)
  }
  if (filters.status?.length) {
    clauses.push(`status IN (${filters.status.map(() => "?").join(", ")})`)
    params.push(...filters.status)
  }
  if (filters.entityType?.trim()) {
    clauses.push("entity_type = ?")
    params.push(filters.entityType.trim())
  }
  if (filters.source?.trim()) {
    clauses.push("source = ?")
    params.push(filters.source.trim())
  }
  if (filters.target?.trim()) {
    clauses.push("target = ?")
    params.push(filters.target.trim())
  }
  if (filters.startedAfter?.trim()) {
    clauses.push("started_at >= ?")
    params.push(filters.startedAfter.trim())
  }
  if (filters.startedBefore?.trim()) {
    clauses.push("started_at <= ?")
    params.push(`${filters.startedBefore.trim()} 23:59:59`)
  }
  const search = filters.search?.trim()
  if (search) {
    const q = `%${search}%`
    clauses.push(
      `(entity_display_name LIKE ? OR entity_id LIKE ? OR entity_type LIKE ? OR plan_id LIKE ? OR source LIKE ? OR target LIKE ? OR actor_upn LIKE ?)`
    )
    params.push(q, q, q, q, q, q, q)
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  }
}

export function countSyncRuns(filters: SyncRunHistoryFilters = {}): number {
  const { where, params } = buildSyncRunHistoryWhere(filters)
  const row = getDb().prepare(`SELECT COUNT(1) AS c FROM sync_runs ${where}`).get(...params) as { c: number }
  return row.c
}

export function listSyncRunsPaginated(input: ListSyncRunsPaginatedInput): SyncRunRow[] {
  const page = Math.max(1, input.page)
  const pageSize = Math.max(1, input.pageSize)
  const offset = (page - 1) * pageSize
  const { where, params } = buildSyncRunHistoryWhere(input)
  const orderBy = syncRunHistoryOrderBy(input.sort)
  return getDb()
    .prepare(`SELECT * FROM sync_runs ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as SyncRunRow[]
}

export function getSyncRun(planId: string): SyncRunRow | undefined {
  return getDb().prepare(`SELECT * FROM sync_runs WHERE plan_id = ?`).get(planId) as SyncRunRow | undefined
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
  const actorUpn = requireSyncRunActorUpn(i.actorUpn, "recordSyncRunPreview")
  const c = asCounts(i.previewTotals)
  // Don't clobber an in-progress / completed run with a "preview" status.
  // Use INSERT … ON CONFLICT to only overwrite plan_json + preview metadata
  // for already-existing rows, leaving status / timestamps intact.
  getDb()
    .prepare(
      `INSERT INTO sync_runs
         (plan_id, entity_type, entity_id, entity_display_name, source, target,
          actor_upn, preview_inserts, preview_updates, preview_deletes,
          preview_totals_json, plan_json, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(plan_id) DO UPDATE SET
         plan_json = excluded.plan_json,
         preview_totals_json = excluded.preview_totals_json,
         preview_inserts = excluded.preview_inserts,
         preview_updates = excluded.preview_updates,
         preview_deletes = excluded.preview_deletes,
         entity_display_name = COALESCE(excluded.entity_display_name, sync_runs.entity_display_name)`
    )
    .run(
      i.planId,
      i.entityType,
      String(i.entityId),
      i.entityDisplayName,
      i.source,
      i.target,
      actorUpn,
      c.insert ?? 0,
      c.update ?? 0,
      c.delete ?? 0,
      JSON.stringify(i.previewTotals),
      i.planJson,
      SyncRunStatus.Preview
    )
}

/** Re-hydrate the full plan body for a given planId, or null if absent. */
export function getSyncRunPlanJson(planId: string): string | null {
  const row = getDb().prepare(`SELECT plan_json FROM sync_runs WHERE plan_id = ?`).get(planId) as
    | { plan_json: string | null }
    | undefined
  return row?.plan_json ?? null
}
