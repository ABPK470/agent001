/**
 * Notification persistence.
 */

import { getDb } from "./connection.js"

export interface DbNotification {
  id: string
  type: string        // 'run.failed' | 'run.completed' | 'approval.required' | 'run.recovered'
  title: string
  message: string
  run_id: string | null
  step_id: string | null
  actions: string     // JSON array of { label, action, data }
  read: number        // 0 or 1
  created_at: string
}

export function migrateNotifications(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      run_id TEXT,
      step_id TEXT,
      actions TEXT NOT NULL DEFAULT '[]',
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at DESC);
  `)
}

export function saveNotification(n: DbNotification): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO notifications (id, type, title, message, run_id, step_id, actions, read, created_at)
    VALUES (@id, @type, @title, @message, @run_id, @step_id, @actions, @read, @created_at)
  `).run(n)
}

export function listNotifications(limit = 50): DbNotification[] {
  return getDb()
    .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?")
    .all(limit) as DbNotification[]
}

export function markNotificationRead(id: string): void {
  getDb().prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id)
}

export function markAllNotificationsRead(): void {
  getDb().prepare("UPDATE notifications SET read = 1 WHERE read = 0").run()
}

export function getUnreadNotificationCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) as count FROM notifications WHERE read = 0").get() as { count: number }
  return row.count
}
