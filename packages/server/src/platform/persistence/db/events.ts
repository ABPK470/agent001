/**
 * Unified event log & webhook drain persistence.
 */

import { getDb } from "./connection.js"

export interface DbEvent {
  id: number
  type: string
  data: string
  created_at: string
}

export function saveEvent(type: string, data: Record<string, unknown>, timestamp: string): void {
  getDb()
    .prepare(
      `
    INSERT INTO event_log (type, data, created_at)
    VALUES (?, ?, ?)
  `
    )
    .run(type, JSON.stringify(data), timestamp)
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

/** Full-text search across event_log data JSON. Used by the DB-fallback
 *  search in LiveLogs widget when in-memory buffer has no matches. */
export function searchEvents(
  q: string,
  opts?: {
    limit?: number
    types?: string[]
    type_patterns?: string[]
    before?: string
    after?: string
  }
): DbEvent[] {
  const limit = Math.min(opts?.limit ?? 200, 1000)
  const conditions: string[] = []
  const params: unknown[] = []

  // Free-text: search both the data JSON blob AND the type column so that
  // e.g. searching "failed" finds events whose type contains "failed".
  if (q.length >= 2) {
    conditions.push("(data LIKE ? OR type LIKE ?)")
    params.push(`%${q}%`, `%${q}%`)
  }
  if (opts?.before) {
    conditions.push("created_at < ?")
    params.push(opts.before)
  }
  if (opts?.after) {
    conditions.push("created_at > ?")
    params.push(opts.after)
  }
  if (opts?.types?.length) {
    conditions.push(`type IN (${opts.types.map(() => "?").join(",")})`)
    params.push(...opts.types)
  }
  // type_patterns: OR'd LIKE filters on the type column. Used by err:1 to
  // find events like sync.execute.step.failed / run.failed / agent.error.
  if (opts?.type_patterns?.length) {
    const pats = opts.type_patterns.map(() => "type LIKE ?")
    conditions.push(`(${pats.join(" OR ")})`)
    params.push(...opts.type_patterns.map((p) => `%${p}%`))
  }

  if (!conditions.length) return []
  params.push(limit)
  return getDb()
    .prepare(`SELECT * FROM event_log WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as DbEvent[]
}

export interface DbWebhookDrain {
  id: string
  url: string
  secret: string
  event_filters: string // JSON array of type prefixes, e.g. ["run.", "audit"]
  enabled: number // 0 or 1
  created_at: string
  updated_at: string
}

export function listWebhookDrains(): DbWebhookDrain[] {
  return getDb().prepare("SELECT * FROM webhook_drains ORDER BY created_at").all() as DbWebhookDrain[]
}

export function getWebhookDrain(id: string): DbWebhookDrain | undefined {
  return getDb().prepare("SELECT * FROM webhook_drains WHERE id = ?").get(id) as DbWebhookDrain | undefined
}

export function saveWebhookDrain(drain: DbWebhookDrain): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO webhook_drains (id, url, secret, event_filters, enabled, created_at, updated_at)
    VALUES (@id, @url, @secret, @event_filters, @enabled, @created_at, @updated_at)
  `
    )
    .run(drain)
}

export function deleteWebhookDrain(id: string): void {
  getDb().prepare("DELETE FROM webhook_drains WHERE id = ?").run(id)
}
