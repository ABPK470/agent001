/**
 * Thread persistence — named conversation workspaces grouping multiple runs.
 */

import { randomUUID } from "node:crypto"
import { getDb } from "./connection.js"

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
export const PLATFORM_THREAD_TITLE = "Platform"

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  )
}

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

/** Idempotent — one active Platform thread per user (enforced by partial unique index). */
export function ensurePlatformThread(upn: string): DbThread {
  const existing = getDb()
    .prepare(
      `
      SELECT * FROM threads
      WHERE upn = ? AND title = ? AND archived_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `
    )
    .get(upn, PLATFORM_THREAD_TITLE) as DbThread | undefined
  if (existing) return existing
  try {
    return createThread(upn, PLATFORM_THREAD_TITLE)
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err
    const raced = getDb()
      .prepare(
        `
        SELECT * FROM threads
        WHERE upn = ? AND title = ? AND archived_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `
      )
      .get(upn, PLATFORM_THREAD_TITLE) as DbThread | undefined
    if (raced) return raced
    throw err
  }
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
  if (!thread || (thread.title !== DEFAULT_TITLE && thread.title !== PLATFORM_THREAD_TITLE)) return
  const trimmed = goal.trim().replace(/\s+/g, " ")
  if (!trimmed) return
  const title = trimmed.length > 72 ? `${trimmed.slice(0, 69)}…` : trimmed
  updateThread(threadId, { title })
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
