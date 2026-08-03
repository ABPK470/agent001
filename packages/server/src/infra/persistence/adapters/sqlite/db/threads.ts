/**
 * Thread persistence — named conversation workspaces grouping multiple runs.
 */

import { randomUUID } from "node:crypto"
import { sql } from "kysely"
import { getDb } from "../connection.js"
import { getPlatformStore } from "../platform-store.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"

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
    pinned: 0,
  }
  const compiled = getPlatformDb()
    .insertInto("threads")
    .values({
      id: row.id,
      upn: row.upn,
      title: row.title,
      created_at: row.created_at,
      updated_at: row.updated_at,
      archived_at: null,
      pinned: 0,
    })
    .compile()
  runExec(compiled)
  return row
}

export function getThread(id: string): DbThread | undefined {
  const compiled = getPlatformDb()
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<DbThread>(compiled)
}

export function listThreadsForUser(
  upn: string,
  opts: { includeArchived?: boolean } = {}
): DbThreadWithRunCount[] {
  const { includeArchived = false } = opts
  let query = getPlatformDb()
    .selectFrom("threads as t")
    .leftJoin("runs as r", "r.thread_id", "t.id")
    .select([
      "t.id",
      "t.upn",
      "t.title",
      "t.created_at",
      "t.updated_at",
      "t.archived_at",
      "t.pinned",
      sql<number>`count(r.id)`.as("run_count"),
    ])
    .where("t.upn", "=", upn)
    .groupBy("t.id")
  if (!includeArchived) {
    query = query.where("t.archived_at", "is", null)
  }
  const compiled = query
    .orderBy("t.pinned", "desc")
    .orderBy("t.updated_at", "desc")
    .compile()
  return runAll<DbThreadWithRunCount>(compiled)
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
    updated_at: new Date().toISOString(),
  }
  const compiled = getPlatformDb()
    .updateTable("threads")
    .set({
      title: next.title,
      archived_at: next.archived_at,
      pinned: next.pinned,
      updated_at: next.updated_at,
    })
    .where("id", "=", id)
    .compile()
  runExec(compiled)
  return next
}

export function touchThread(id: string, at = new Date().toISOString()): void {
  const compiled = getPlatformDb()
    .updateTable("threads")
    .set({ updated_at: at })
    .where("id", "=", id)
    .compile()
  runExec(compiled)
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
  const compiled = getPlatformDb()
    .selectFrom("runs")
    .select("id")
    .where("thread_id", "=", threadId)
    .where("upn", "=", upn.toLowerCase())
    .compile()
  return runAll<{ id: string }>(compiled).map((r) => r.id)
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
  const normalizedUpn = upn.toLowerCase()

  getPlatformStore().transaction(() => {
    if (runIds.length > 0) {
      // memory_entries / event_log not yet on the schema toolkit — raw until those repos move.
      const placeholders = runIds.map(() => "?").join(",")
      getDb().prepare(`DELETE FROM memory_entries WHERE run_id IN (${placeholders})`).run(...runIds)
      for (const runId of runIds) {
        getDb().prepare(`DELETE FROM event_log WHERE run_id = ?`).run(runId)
      }
      const delRuns = getPlatformDb()
        .deleteFrom("runs")
        .where("thread_id", "=", threadId)
        .where("upn", "=", normalizedUpn)
        .compile()
      runExec(delRuns)
    }
    const clearConv = getPlatformDb()
      .updateTable("conversations")
      .set({ thread_id: null })
      .where("thread_id", "=", threadId)
      .compile()
    runExec(clearConv)
    const delThread = getPlatformDb()
      .deleteFrom("threads")
      .where("id", "=", threadId)
      .where("upn", "=", normalizedUpn)
      .compile()
    runExec(delThread)
  })

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
