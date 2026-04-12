/**
 * Unified event log & webhook drain persistence.
 */

import { getDb } from "./connection.js"

// ── Event log ────────────────────────────────────────────────────

export function migrateEventLog(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_log_time ON event_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(type);
  `)
}

export interface DbEvent {
  id: number
  type: string
  data: string
  created_at: string
}

export function saveEvent(type: string, data: Record<string, unknown>, timestamp: string): void {
  getDb().prepare(`
    INSERT INTO event_log (type, data, created_at)
    VALUES (?, ?, ?)
  `).run(type, JSON.stringify(data), timestamp)
}

export function listEvents(opts?: {
  limit?: number
  before?: string
  after?: string
  types?: string[]
}): DbEvent[] {
  const limit = opts?.limit ?? 200
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts?.before) {
    conditions.push("created_at < ?")
    params.push(opts.before)
  }
  if (opts?.after) {
    conditions.push("created_at > ?")
    params.push(opts.after)
  }
  if (opts?.types && opts.types.length > 0) {
    conditions.push(`type IN (${opts.types.map(() => "?").join(",")})`)
    params.push(...opts.types)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
  params.push(limit)

  return getDb()
    .prepare(`SELECT * FROM event_log ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as DbEvent[]
}

// ── Webhook drains ───────────────────────────────────────────────

export function migrateWebhookDrains(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS webhook_drains (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      secret TEXT NOT NULL DEFAULT '',
      event_filters TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

export interface DbWebhookDrain {
  id: string
  url: string
  secret: string
  event_filters: string   // JSON array of type prefixes, e.g. ["run.", "audit"]
  enabled: number         // 0 or 1
  created_at: string
  updated_at: string
}

export function listWebhookDrains(): DbWebhookDrain[] {
  return getDb()
    .prepare("SELECT * FROM webhook_drains ORDER BY created_at")
    .all() as DbWebhookDrain[]
}

export function getWebhookDrain(id: string): DbWebhookDrain | undefined {
  return getDb()
    .prepare("SELECT * FROM webhook_drains WHERE id = ?")
    .get(id) as DbWebhookDrain | undefined
}

export function saveWebhookDrain(drain: DbWebhookDrain): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO webhook_drains (id, url, secret, event_filters, enabled, created_at, updated_at)
    VALUES (@id, @url, @secret, @event_filters, @enabled, @created_at, @updated_at)
  `).run(drain)
}

export function deleteWebhookDrain(id: string): void {
  getDb().prepare("DELETE FROM webhook_drains WHERE id = ?").run(id)
}
