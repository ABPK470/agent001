/**
 * Thread persistence — named conversation workspaces grouping multiple runs.
 *
 * `kind=workspace` is the single widget continuity thread per user. It is
 * provisioned at account creation, excluded from GET /api/threads, and
 * identified by kind — never by title.
 */

import { randomUUID } from "node:crypto"
import { ThreadKind } from "../../../shared/enums/thread.js"
import { getDb } from "./connection.js"

export interface DbThread {
  id: string
  upn: string
  title: string
  kind: ThreadKind
  created_at: string
  updated_at: string
  archived_at: string | null
  pinned: number
}

export interface DbThreadWithRunCount extends DbThread {
  run_count: number
}

const DEFAULT_TITLE = "New thread"

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  )
}

function insertThread(
  upn: string,
  title: string,
  kind: ThreadKind
): DbThread {
  const now = new Date().toISOString()
  const row: DbThread = {
    id: randomUUID(),
    upn,
    title: title.trim() || DEFAULT_TITLE,
    kind,
    created_at: now,
    updated_at: now,
    archived_at: null,
    pinned: 0
  }
  getDb()
    .prepare(
      `
      INSERT INTO threads (id, upn, title, kind, created_at, updated_at, archived_at, pinned)
      VALUES (@id, @upn, @title, @kind, @created_at, @updated_at, NULL, 0)
    `
    )
    .run(row)
  return row
}

/** Sidebar thread — always `kind=conversation`. */
export function createThread(upn: string, title = DEFAULT_TITLE): DbThread {
  return insertThread(upn, title, ThreadKind.Conversation)
}

export function getWorkspaceThread(upn: string): DbThread | undefined {
  return getDb()
    .prepare(
      `
      SELECT * FROM threads
      WHERE upn = ? AND kind = ? AND archived_at IS NULL
      LIMIT 1
    `
    )
    .get(upn, ThreadKind.Workspace) as DbThread | undefined
}

/** Create the widget workspace thread. Unique index enforces one per user. */
export function createWorkspaceThread(upn: string): DbThread {
  return insertThread(upn, DEFAULT_TITLE, ThreadKind.Workspace)
}

/**
 * Idempotent — returns the user's workspace thread, creating it if missing
 * (e.g. legacy users seeded before provisioning existed).
 */
export function provisionWorkspaceThread(upn: string): DbThread {
  const existing = getWorkspaceThread(upn)
  if (existing) return existing
  try {
    return createWorkspaceThread(upn)
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err
    const raced = getWorkspaceThread(upn)
    if (raced) return raced
    throw err
  }
}

export function resolveWorkspaceThreadId(upn: string): string {
  return provisionWorkspaceThread(upn).id
}

export function getThread(id: string): DbThread | undefined {
  return getDb().prepare("SELECT * FROM threads WHERE id = ?").get(id) as DbThread | undefined
}

export function listThreadsForUser(
  upn: string,
  opts: { includeArchived?: boolean; includeWorkspace?: boolean } = {}
): DbThreadWithRunCount[] {
  const { includeArchived = false, includeWorkspace = false } = opts
  return getDb()
    .prepare(
      `
      SELECT t.*, COUNT(r.id) AS run_count
      FROM threads t
      LEFT JOIN runs r ON r.thread_id = t.id
      WHERE t.upn = @upn
        AND (@includeArchived = 1 OR t.archived_at IS NULL)
        AND (@includeWorkspace = 1 OR t.kind = @conversationKind)
      GROUP BY t.id
      ORDER BY t.pinned DESC, t.updated_at DESC
    `
    )
    .all({
      upn,
      includeArchived: includeArchived ? 1 : 0,
      includeWorkspace: includeWorkspace ? 1 : 0,
      conversationKind: ThreadKind.Conversation
    }) as DbThreadWithRunCount[]
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
  if (!thread) return
  const isUntitled =
    thread.kind === ThreadKind.Workspace || thread.title === DEFAULT_TITLE
  if (!isUntitled) return
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
