/**
 * Notification persistence.
 */

import { sql } from "kysely"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"

export interface DbNotification {
  id: string
  type: string // 'run.failed' | 'run.completed' | 'approval.required' | 'run.recovered'
  title: string
  message: string
  run_id: string | null
  step_id: string | null
  /** Owner UPN — always set; FK to users(upn). */
  owner_upn: string
  actions: string // JSON array of { label, action, data }
  read: number // 0 or 1
  created_at: string
}

export function saveNotification(n: DbNotification): void {
  const compiled = getPlatformDb()
    .insertInto("notifications")
    .orReplace()
    .values({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      run_id: n.run_id,
      step_id: n.step_id,
      owner_upn: n.owner_upn,
      actions: n.actions,
      read: n.read,
      created_at: n.created_at,
    })
    .compile()
  runExec(compiled)
}

export function getNotification(id: string): DbNotification | undefined {
  const compiled = getPlatformDb()
    .selectFrom("notifications")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<DbNotification>(compiled)
}

export function listNotifications(limit = 50): DbNotification[] {
  const compiled = getPlatformDb()
    .selectFrom("notifications")
    .selectAll()
    .orderBy("created_at", "desc")
    .limit(limit)
    .compile()
  return runAll<DbNotification>(compiled)
}

/** Notifications visible to a logged-in user (upn-scoped + system-wide). */
export function listNotificationsForUser(upn: string, limit = 50): DbNotification[] {
  const compiled = getPlatformDb()
    .selectFrom("notifications")
    .selectAll()
    .where((eb) => eb.or([eb("owner_upn", "is", null), eb("owner_upn", "=", upn)]))
    .orderBy("created_at", "desc")
    .limit(limit)
    .compile()
  return runAll<DbNotification>(compiled)
}

export function markNotificationRead(id: string): void {
  const compiled = getPlatformDb()
    .updateTable("notifications")
    .set({ read: 1 })
    .where("id", "=", id)
    .compile()
  runExec(compiled)
}

export function markAllNotificationsRead(): void {
  const compiled = getPlatformDb()
    .updateTable("notifications")
    .set({ read: 1 })
    .where("read", "=", 0)
    .compile()
  runExec(compiled)
}

export function getUnreadNotificationCount(): number {
  const compiled = getPlatformDb()
    .selectFrom("notifications")
    .select(sql<number>`count(*)`.as("count"))
    .where("read", "=", 0)
    .compile()
  const row = runGet<{ count: number | bigint }>(compiled)
  return Number(row?.count ?? 0)
}

export function getUnreadNotificationCountForUser(upn: string): number {
  const compiled = getPlatformDb()
    .selectFrom("notifications")
    .select(sql<number>`count(*)`.as("count"))
    .where("read", "=", 0)
    .where((eb) => eb.or([eb("owner_upn", "is", null), eb("owner_upn", "=", upn)]))
    .compile()
  const row = runGet<{ count: number | bigint }>(compiled)
  return Number(row?.count ?? 0)
}
