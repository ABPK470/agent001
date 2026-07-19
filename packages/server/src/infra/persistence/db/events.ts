/**
 * Unified event log & webhook drain persistence.
 */

import { getDb } from "../connection.js"

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

  // Free-text: each word (≥2 chars) must appear in type OR data JSON.
  // e.g. "preview started" matches type sync.preview.started.
  if (q.length >= 2) {
    const words = q.split(/\s+/).filter((w) => w.length >= 2)
    for (const word of words) {
      conditions.push("(data LIKE ? OR type LIKE ?)")
      params.push(`%${word}%`, `%${word}%`)
    }
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

/** All sync events for a plan (chronological). Used by plan-scoped operation audit. */
export function listEventsForPlanId(planId: string, opts?: { limit?: number }): DbEvent[] {
  const limit = Math.min(opts?.limit ?? 20_000, 50_000)
  const db = getDb()

  const primary = db
    .prepare(
      `
    SELECT * FROM event_log
    WHERE type LIKE 'sync.%'
      AND (
        json_extract(data, '$.planId') = ?
        OR json_extract(data, '$.opId') = ?
      )
    ORDER BY created_at ASC
    LIMIT ?
  `
    )
    .all(planId, planId, limit) as DbEvent[]

  const previewIds = new Set<string>()
  for (const row of primary) {
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>
      for (const key of ["previewId", "opId"] as const) {
        const id = data[key]
        if (typeof id === "string" && id.length > 0 && id !== planId) previewIds.add(id)
      }
    } catch {
      /* ignore malformed rows */
    }
  }

  if (previewIds.size === 0) return primary

  const placeholders = [...previewIds].map(() => "?").join(",")
  const correlated = db
    .prepare(
      `
    SELECT * FROM event_log
    WHERE type LIKE 'sync.%'
      AND json_extract(data, '$.opId') IN (${placeholders})
    ORDER BY created_at ASC
  `
    )
    .all(...previewIds) as DbEvent[]

  const byId = new Map<number, DbEvent>()
  for (const row of [...primary, ...correlated]) byId.set(row.id, row)
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/** All events carrying a runId (chronological). Used by run-scoped operation audit. */
export function listEventsForRunId(runId: string, opts?: { limit?: number }): DbEvent[] {
  const limit = Math.min(opts?.limit ?? 20_000, 50_000)
  return getDb()
    .prepare(
      `
    SELECT * FROM event_log
    WHERE json_extract(data, '$.runId') = ?
    ORDER BY created_at ASC
    LIMIT ?
  `
    )
    .all(runId, limit) as DbEvent[]
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
  return getDb().prepare("SELECT * FROM webhook_drain_configs ORDER BY created_at").all() as DbWebhookDrain[]
}

export function getWebhookDrain(id: string): DbWebhookDrain | undefined {
  return getDb().prepare("SELECT * FROM webhook_drain_configs WHERE id = ?").get(id) as DbWebhookDrain | undefined
}

export function saveWebhookDrain(drain: DbWebhookDrain): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO webhook_drain_configs (id, url, secret, event_filters, enabled, created_at, updated_at)
    VALUES (@id, @url, @secret, @event_filters, @enabled, @created_at, @updated_at)
  `
    )
    .run(drain)
}

export function deleteWebhookDrain(id: string): void {
  getDb().prepare("DELETE FROM webhook_drain_configs WHERE id = ?").run(id)
}
