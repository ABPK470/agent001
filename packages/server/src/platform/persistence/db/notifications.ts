/**
 * Notification persistence.
 */

import { getDb } from "../connection.js"

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
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO notifications (id, type, title, message, run_id, step_id, owner_upn, actions, read, created_at)
    VALUES (@id, @type, @title, @message, @run_id, @step_id, @owner_upn, @actions, @read, @created_at)
  `
    )
    .run(n)
}

export function getNotification(id: string): DbNotification | undefined {
  return getDb().prepare("SELECT * FROM notifications WHERE id = ?").get(id) as DbNotification | undefined
}

export function listNotifications(limit = 50): DbNotification[] {
  return getDb()
    .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?")
    .all(limit) as DbNotification[]
}

/** Notifications visible to a logged-in user (upn-scoped + system-wide). */
export function listNotificationsForUser(upn: string, limit = 50): DbNotification[] {
  return getDb()
    .prepare(
      `
      SELECT * FROM notifications
      WHERE owner_upn IS NULL OR owner_upn = @upn
      ORDER BY created_at DESC LIMIT @limit
    `
    )
    .all({ upn, limit }) as DbNotification[]
}

export function markNotificationRead(id: string): void {
  getDb().prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id)
}

export function markAllNotificationsRead(): void {
  getDb().prepare("UPDATE notifications SET read = 1 WHERE read = 0").run()
}

export function getUnreadNotificationCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) as count FROM notifications WHERE read = 0").get() as {
    count: number
  }
  return row.count
}

export function getUnreadNotificationCountForUser(upn: string): number {
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) as count FROM notifications
      WHERE read = 0 AND (owner_upn IS NULL OR owner_upn = @upn)
    `
    )
    .get({ upn }) as { count: number }
  return row.count
}
