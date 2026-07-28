/**
 * SQLite EventStore — batched durable append off the SSE hot path.
 */

import { getDb } from "../connection.js"
import type {
  DurableEvent,
  EventListOpts,
  EventSearchOpts,
  EventStore,
  StoredEvent,
} from "../../../../../ports/event-store.js"
import { toDurableEvent } from "../../../../../ports/event-store.js"

const BATCH_SIZE = 64

export class SqliteEventStore implements EventStore {
  private readonly pending: DurableEvent[] = []
  private flushScheduled = false
  private lastFlushMs = 0

  append(event: DurableEvent): void {
    this.pending.push(event)
    this.scheduleFlush()
  }

  queueDepth(): number {
    return this.pending.length
  }

  /** Last flush duration in ms (for cheap counters). */
  lastFlushDurationMs(): number {
    return this.lastFlushMs
  }

  flush(): void {
    this.flushScheduled = false
    if (this.pending.length === 0) return
    const batch = this.pending.splice(0, this.pending.length)
    const started = Date.now()
    try {
      this.insertBatch(batch)
    } catch (err: unknown) {
      if (isDatabaseClosed(err)) {
        // Teardown / shutdown — named drop, not silent forever-retry.
        console.error("[mia] event_store.flush skipped; database closed", err)
        return
      }
      // Named failure — re-queue so durability is not silently dropped.
      this.pending.unshift(...batch)
      console.error("[mia] event_store.flush failed; re-queued", err)
      this.scheduleFlush()
      throw err
    } finally {
      this.lastFlushMs = Date.now() - started
    }
  }

  list(opts?: EventListOpts): StoredEvent[] {
    this.flush()
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
    if (opts?.since) {
      conditions.push("created_at >= ?")
      params.push(opts.since)
    }
    if (opts?.until) {
      conditions.push("created_at <= ?")
      params.push(opts.until)
    }
    if (opts?.types && opts.types.length > 0) {
      conditions.push(`type IN (${opts.types.map(() => "?").join(",")})`)
      params.push(...opts.types)
    }
    if (opts?.excludeTypes && opts.excludeTypes.length > 0) {
      conditions.push(`type NOT IN (${opts.excludeTypes.map(() => "?").join(",")})`)
      params.push(...opts.excludeTypes)
    }
    if (opts?.actorUpn) {
      conditions.push("actor_upn = ?")
      params.push(opts.actorUpn.trim().toLowerCase())
    }
    if (opts?.runId) {
      conditions.push("run_id = ?")
      params.push(opts.runId)
    }
    if (opts?.planId) {
      conditions.push("plan_id = ?")
      params.push(opts.planId)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    params.push(limit)
    return getDb()
      .prepare(`SELECT * FROM event_log ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as StoredEvent[]
  }

  search(q: string, opts?: EventSearchOpts): StoredEvent[] {
    this.flush()
    const limit = Math.min(opts?.limit ?? 200, 1000)
    const conditions: string[] = []
    const params: unknown[] = []

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
    if (opts?.since) {
      conditions.push("created_at >= ?")
      params.push(opts.since)
    }
    if (opts?.until) {
      conditions.push("created_at <= ?")
      params.push(opts.until)
    }
    if (opts?.types?.length) {
      conditions.push(`type IN (${opts.types.map(() => "?").join(",")})`)
      params.push(...opts.types)
    }
    if (opts?.type_patterns?.length) {
      const pats = opts.type_patterns.map(() => "type LIKE ?")
      conditions.push(`(${pats.join(" OR ")})`)
      params.push(...opts.type_patterns.map((p) => `%${p}%`))
    }

    if (!conditions.length) return []
    params.push(limit)
    return getDb()
      .prepare(
        `SELECT * FROM event_log WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params) as StoredEvent[]
  }

  listForPlanId(planId: string, opts?: { limit?: number }): StoredEvent[] {
    this.flush()
    const limit = Math.min(opts?.limit ?? 20_000, 50_000)
    const db = getDb()

    const primary = db
      .prepare(
        `
      SELECT * FROM event_log
      WHERE type LIKE 'sync.%'
        AND (plan_id = ? OR json_extract(data, '$.opId') = ?)
      ORDER BY created_at ASC
      LIMIT ?
    `,
      )
      .all(planId, planId, limit) as StoredEvent[]

    const previewIds = new Set<string>()
    for (const row of primary) {
      try {
        const data = JSON.parse(row.data) as Record<string, unknown>
        for (const key of ["previewId", "opId"] as const) {
          const id = data[key]
          if (typeof id === "string" && id.length > 0 && id !== planId) previewIds.add(id)
        }
      } catch (err: unknown) {
        console.error("[mia]", err)
      }
    }

    if (previewIds.size === 0) return primary

    const placeholders = [...previewIds].map(() => "?").join(",")
    const correlated = db
      .prepare(
        `
      SELECT * FROM event_log
      WHERE type LIKE 'sync.%'
        AND (
          plan_id IN (${placeholders})
          OR json_extract(data, '$.opId') IN (${placeholders})
        )
      ORDER BY created_at ASC
    `,
      )
      .all(...previewIds, ...previewIds) as StoredEvent[]

    const byId = new Map<number, StoredEvent>()
    for (const row of [...primary, ...correlated]) byId.set(row.id, row)
    return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  listForRunId(runId: string, opts?: { limit?: number }): StoredEvent[] {
    this.flush()
    const limit = Math.min(opts?.limit ?? 20_000, 50_000)
    return getDb()
      .prepare(
        `
      SELECT * FROM event_log
      WHERE run_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `,
      )
      .all(runId, limit) as StoredEvent[]
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    // Off the SSE stack — microtask then setImmediate for a short batch window.
    queueMicrotask(() => {
      setImmediate(() => {
        try {
          this.flush()
        } catch (err: unknown) {
          console.error("[mia] event_store.scheduled_flush", err)
        }
      })
    })
  }

  private insertBatch(batch: DurableEvent[]): void {
    const db = getDb()
    const insert = db.prepare(`
      INSERT INTO event_log (type, data, created_at, actor_upn, run_id, plan_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const run = db.transaction((rows: DurableEvent[]) => {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const slice = rows.slice(i, i + BATCH_SIZE)
        for (const e of slice) {
          insert.run(
            e.type,
            JSON.stringify(e.data),
            e.createdAt,
            e.actorUpn,
            e.runId,
            e.planId,
          )
        }
      }
    })
    run(batch)
  }
}

const _default = new SqliteEventStore()

export function getEventStore(): EventStore {
  return _default
}

/** Sync convenience used by existing callers / broadcaster. */
export function saveEvent(type: string, data: Record<string, unknown>, timestamp: string): void {
  _default.append(toDurableEvent(type, data, timestamp))
}

export function listEvents(opts?: EventListOpts): StoredEvent[] {
  return _default.list(opts)
}

export function searchEvents(q: string, opts?: EventSearchOpts): StoredEvent[] {
  return _default.search(q, opts)
}

export function listEventsForPlanId(planId: string, opts?: { limit?: number }): StoredEvent[] {
  return _default.listForPlanId(planId, opts)
}

export function listEventsForRunId(runId: string, opts?: { limit?: number }): StoredEvent[] {
  return _default.listForRunId(runId, opts)
}

export function flushEventStore(): void {
  _default.flush()
}

function isDatabaseClosed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /not open|closed|readonly/i.test(msg)
}
