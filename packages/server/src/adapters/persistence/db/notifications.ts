/**
 * Notification persistence.
 */

import { getDb, migrateSessionFkSetNull } from "./connection.js"

export interface DbNotification {
  id: string
  type: string // 'run.failed' | 'run.completed' | 'approval.required' | 'run.recovered'
  title: string
  message: string
  run_id: string | null
  step_id: string | null
  /** Owner UPN — always set; FK to users(upn). */
  owner_upn: string
  /** Originating session — nullable for cross-session notifications. */
  session_id: string | null
  actions: string // JSON array of { label, action, data }
  read: number // 0 or 1
  created_at: string
}

export function migrateNotifications(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      title      TEXT NOT NULL,
      message    TEXT NOT NULL,
      run_id     TEXT REFERENCES runs(id)     ON DELETE CASCADE,
      step_id    TEXT,
      owner_upn  TEXT NOT NULL REFERENCES users(upn) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(sid) ON DELETE SET NULL,
      actions    TEXT NOT NULL DEFAULT '[]',
      read       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_read     ON notifications(read, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_owner    ON notifications(owner_upn, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_session  ON notifications(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_run      ON notifications(run_id);
  `)
  // Existing DBs may still have ON DELETE CASCADE on session_id from
  // pre-v23 — rewrite if so. No-op when already on the new schema.
  migrateSessionFkSetNull(db)
}

export function saveNotification(n: DbNotification): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO notifications (id, type, title, message, run_id, step_id, owner_upn, session_id, actions, read, created_at)
    VALUES (@id, @type, @title, @message, @run_id, @step_id, @owner_upn, @session_id, @actions, @read, @created_at)
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

/**
 * Notifications visible to a non-admin user. Includes:
 *   - notifications with no owner (system-wide), and
 *   - notifications owned by this user (matched by upn or session id).
 */
export function listNotificationsForUser(
  opts: { upn?: string | null; sid?: string | null },
  limit = 50
): DbNotification[] {
  const upn = opts.upn ?? null
  const sid = opts.sid ?? null
  return getDb()
    .prepare(
      `
      SELECT * FROM notifications
      WHERE (owner_upn IS NULL AND session_id IS NULL)
         OR (@upn IS NOT NULL AND owner_upn = @upn)
         OR (@upn IS NULL AND @sid IS NOT NULL AND session_id = @sid)
      ORDER BY created_at DESC LIMIT @limit
    `
    )
    .all({ upn, sid, limit }) as DbNotification[]
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

export function getUnreadNotificationCountForUser(opts: {
  upn?: string | null
  sid?: string | null
}): number {
  const upn = opts.upn ?? null
  const sid = opts.sid ?? null
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) as count FROM notifications
      WHERE read = 0 AND (
        (owner_upn IS NULL AND session_id IS NULL)
        OR (@upn IS NOT NULL AND owner_upn = @upn)
        OR (@upn IS NULL AND @sid IS NOT NULL AND session_id = @sid)
      )
    `
    )
    .get({ upn, sid }) as { count: number }
  return row.count
}
