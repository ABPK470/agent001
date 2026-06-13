/**
 * Thread persistence — named conversation workspaces grouping multiple runs.
 */

import { randomUUID } from "node:crypto"
import { getDb } from "../connection.js"

export interface DbThread {
  id: string
  upn: string
  title: string
  created_at: string
  updated_at: string
  archived_at: string | null
  pinned: number
}

export interface DbThreadWithRunCount extends DbThread {
  run_count: number
}

const DEFAULT_TITLE = "New thread"

export function createThread(upn: string, title = DEFAULT_TITLE): DbThread {
  const now = new Date().toISOString()
  const row: DbThread = {
    id: randomUUID(),
    upn,
    title: title.trim() || DEFAULT_TITLE,
    created_at: now,
    updated_at: now,
    archived_at: null,
    pinned: 0
  }
  getDb()
    .prepare(
      `
      INSERT INTO threads (id, upn, title, created_at, updated_at, archived_at, pinned)
      VALUES (@id, @upn, @title, @created_at, @updated_at, NULL, 0)
    `
    )
    .run(row)
  return row
}

export function getThread(id: string): DbThread | undefined {
  return getDb().prepare("SELECT * FROM threads WHERE id = ?").get(id) as DbThread | undefined
}

export function listThreadsForUser(
  upn: string,
  opts: { includeArchived?: boolean } = {}
): DbThreadWithRunCount[] {
  const { includeArchived = false } = opts
  return getDb()
    .prepare(
      `
      SELECT t.*, COUNT(r.id) AS run_count
      FROM threads t
      LEFT JOIN runs r ON r.thread_id = t.id
      WHERE t.upn = @upn
        AND (@includeArchived = 1 OR t.archived_at IS NULL)
      GROUP BY t.id
      ORDER BY t.pinned DESC, t.updated_at DESC
    `
    )
    .all({ upn, includeArchived: includeArchived ? 1 : 0 }) as DbThreadWithRunCount[]
}

export function updateThread(
  id: string,
  patch: Partial<Pick<DbThread, "title" | "archived_at" | "pinned">>
): DbThread | undefined {
  const existing = getThread(id)
  if (!existing) return undefined
  const next: DbThread = {
    ...existing,
    title: patch.title?.trim() ? patch.title.trim() : existing.title,
    archived_at: patch.archived_at !== undefined ? patch.archived_at : existing.archived_at,
    pinned: patch.pinned !== undefined ? patch.pinned : existing.pinned,
    updated_at: new Date().toISOString()
  }
  getDb()
    .prepare(
      `
      UPDATE threads
      SET title = @title, archived_at = @archived_at, pinned = @pinned, updated_at = @updated_at
      WHERE id = @id
    `
    )
    .run(next)
  return next
}

export function touchThread(id: string, at = new Date().toISOString()): void {
  getDb().prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(at, id)
}

export function autoTitleThreadFromGoal(threadId: string, goal: string): void {
  const thread = getThread(threadId)
  if (!thread || thread.title !== DEFAULT_TITLE) return
  const trimmed = goal.trim().replace(/\s+/g, " ")
  if (!trimmed) return
  const title = trimmed.length > 72 ? `${trimmed.slice(0, 69)}…` : trimmed
  updateThread(threadId, { title })
}

/** List run ids owned by a thread (caller must verify thread access). */
export function listRunIdsForThread(threadId: string, upn: string): string[] {
  const rows = getDb()
    .prepare(
      `
      SELECT id FROM runs
      WHERE thread_id = ? AND upn = ?
    `
    )
    .all(threadId, upn.toLowerCase()) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/**
 * Permanently delete a thread and every run-scoped artifact (memory, trace,
 * attachments, notifications, …). Memory rows use ON DELETE SET NULL on
 * runs, so they are removed explicitly before run deletion.
 */
export function deleteThreadAndRuns(threadId: string, upn: string): { deletedRuns: number } | null {
  const thread = getThread(threadId)
  if (!thread || thread.upn.toLowerCase() !== upn.toLowerCase()) return null

  const runIds = listRunIdsForThread(threadId, upn)
  const db = getDb()

  const purge = db.transaction(() => {
    if (runIds.length > 0) {
      const placeholders = runIds.map(() => "?").join(",")
      db.prepare(`DELETE FROM memory_entries WHERE run_id IN (${placeholders})`).run(...runIds)
      db.prepare(`DELETE FROM procedural_memories WHERE run_id IN (${placeholders})`).run(...runIds)
      for (const runId of runIds) {
        db.prepare(`DELETE FROM event_log WHERE json_extract(data, '$.runId') = ?`).run(runId)
      }
      db.prepare(`DELETE FROM runs WHERE thread_id = ? AND upn = ?`).run(threadId, upn.toLowerCase())
    }
    db.prepare(`UPDATE conversations SET thread_id = NULL WHERE thread_id = ?`).run(threadId)
    db.prepare(`DELETE FROM threads WHERE id = ? AND upn = ?`).run(threadId, upn.toLowerCase())
  })

  purge()
  return { deletedRuns: runIds.length }
}

export function dbThreadToWire(row: DbThreadWithRunCount | DbThread): import("@mia/shared-types").Thread {
  const runCount = "run_count" in row ? row.run_count : undefined
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    pinned: row.pinned === 1,
    runCount
  }
}
